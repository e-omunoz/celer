//! «Probar conexión» paso a paso, cada uno con su tiempo: resolver el nombre del servidor, abrir el puerto, TLS
//! (PostgreSQL lo negocia aquí; MySQL dice en su saludo si lo admite; SQL Server lo negocia dentro del inicio de
//! sesión), iniciar sesión con el driver de verdad y una consulta de prueba en la base. Si algo falla: el error
//! original del driver y, aparte, qué significa y qué hacer.

use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::guard::Connector;
use crate::model::*;

/// Límite de cada paso de red hecho aquí (el inicio de sesión lleva el del driver).
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// resolve | tcp | tls | login | database, or ssh | forward through an SSH tunnel
    pub id: &'static str,
    pub label: String,
    /// ok | failed | skipped
    pub status: &'static str,
    pub ms: u64,
    pub detail: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ok: bool,
    pub steps: Vec<Step>,
    /// Driver y protocolo con los que se llega al servidor.
    pub route: String,
    pub server_info: String,
    pub total_ms: u64,
    /// El error del driver tal cual (puede llevar delante un código para la interfaz: INFORMIX_GUIDE:…).
    pub error: String,
    /// Qué significa y qué hacer ("" si Celer no lo sabe).
    pub hint: String,
}

fn ms(t0: Instant) -> u64 {
    t0.elapsed().as_millis() as u64
}

impl Report {
    fn step(&mut self, id: &'static str, label: &str, status: &'static str, ms: u64, detail: impl Into<String>) {
        self.steps.push(Step { id, label: label.to_string(), status, ms, detail: detail.into() });
    }

    fn fail(&mut self, id: &'static str, label: &str, t0: Instant, error: String, hint: String) {
        self.step(id, label, "failed", ms(t0), short_line(&error));
        self.error = error;
        self.hint = hint;
    }
}

/// La primera línea de un error, para el detalle del paso (el error entero va aparte).
fn short_line(text: &str) -> String {
    crate::guard::short(text)
}

/// Prueba la conexión: los pasos de red con su tiempo (o, por un túnel SSH, el túnel y el reenvío) y después el
/// driver de verdad (`connector`).
pub fn run(cfg: &ConnConfig, connector: Connector, route: &str, tunnel: Option<&crate::ssh::Plan>) -> Report {
    let start = Instant::now();
    let mut r = Report { route: route.to_string(), ..Report::default() };
    match cfg.kind {
        DbKind::Postgres | DbKind::Mysql | DbKind::Mssql | DbKind::Informix => {
            let ready = match tunnel {
                Some(plan) => ssh_steps(plan, &mut r),
                None => network_steps(cfg, &mut r),
            };
            if !ready {
                r.total_ms = ms(start);
                return r;
            }
        }
        DbKind::Sqlite => file_step(cfg, &mut r),
        DbKind::Odbc => {}
    }

    let t0 = Instant::now();
    let mut driver = match connector() {
        Ok(d) => d,
        Err(e) => {
            let text = e.to_string();
            let hint = explain(cfg, &text);
            let label = if cfg.kind == DbKind::Sqlite { "Abrir la base" } else { "Inicio de sesión" };
            if missing_database(&text) {
                // The server took the user and password and then refused the database: that step failed.
                r.step("login", label, "ok", ms(t0), login_detail(cfg, route));
                r.fail("database", "Base de datos", Instant::now(), text, hint);
            } else {
                r.fail("login", label, t0, text, hint);
            }
            r.total_ms = ms(start);
            return r;
        }
    };
    let login_ms = ms(t0);
    let label = if cfg.kind == DbKind::Sqlite { "Abrir la base" } else { "Inicio de sesión" };
    r.step("login", label, "ok", login_ms, login_detail(cfg, route));

    let t1 = Instant::now();
    let probe = probe_sql(cfg);
    let tried = probe.map(|sql| driver.execute(sql, 1).map(|_| ()));
    let query_ms = ms(t1);
    let database = driver.current_database().unwrap_or_default();
    r.server_info = driver.server_info().unwrap_or_default();
    let where_ = if database.is_empty() { "sin base de datos elegida".to_string() } else { format!("base «{database}»") };
    match tried {
        Some(Err(e)) => {
            let text = e.to_string();
            let hint = explain(cfg, &text);
            r.fail("database", "Base de datos", t1, text, hint);
        }
        Some(Ok(())) => r.step("database", "Base de datos", "ok", query_ms, format!("{where_} · consulta de prueba en {query_ms} ms")),
        None => r.step("database", "Base de datos", "ok", query_ms, where_),
    }
    r.ok = r.error.is_empty();
    r.total_ms = ms(start);
    r
}

/// The connect error says the login was accepted but the database does not exist or cannot be opened
/// (PostgreSQL 3D000, MySQL 1049, SQL Server 4060).
fn missing_database(error: &str) -> bool {
    let m = error.to_lowercase();
    ["3d000", "(1049)", "error 1049", "unknown database", "msg 4060", "cannot open database"].iter().any(|w| m.contains(w))
        || (m.contains("database") && m.contains("does not exist"))
}

/// La consulta más barata de cada motor (ODBC genérico: ninguna vale para todos).
fn probe_sql(cfg: &ConnConfig) -> Option<&'static str> {
    match cfg.kind {
        DbKind::Postgres | DbKind::Mysql | DbKind::Mssql | DbKind::Sqlite => Some("SELECT 1"),
        DbKind::Informix if cfg.database.trim().is_empty() => Some("SELECT 1 FROM sysmaster:systables WHERE tabid = 1"),
        DbKind::Informix => Some("SELECT 1 FROM systables WHERE tabid = 1"),
        DbKind::Odbc => None,
    }
}

fn default_port(cfg: &ConnConfig) -> u16 {
    match cfg.kind {
        DbKind::Postgres => 5432,
        DbKind::Mysql => 3306,
        DbKind::Mssql => 1433,
        DbKind::Informix if cfg.informix_mode == "drda" => 9089,
        _ => 9088,
    }
}

fn login_detail(cfg: &ConnConfig, route: &str) -> String {
    let who = if cfg.integrated_auth {
        "autenticación de Windows".to_string()
    } else if cfg.user.trim().is_empty() {
        String::new()
    } else {
        format!("usuario {}", cfg.user.trim())
    };
    let how = if !route.is_empty() {
        route.to_string()
    } else {
        match cfg.kind {
            DbKind::Postgres => "PostgreSQL nativo".into(),
            DbKind::Mysql => "MySQL / MariaDB nativo".into(),
            DbKind::Mssql => "SQL Server nativo (TDS)".into(),
            DbKind::Sqlite => "SQLite embebido".into(),
            DbKind::Odbc => "ODBC".into(),
            DbKind::Informix => String::new(),
        }
    };
    [who, how].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")
}

/// Through an SSH tunnel: logging in to the SSH server (and the jump hosts), then whether the SSH server reaches the
/// database server. The database's own steps (login, database) come after, apart. Returns whether to go on.
fn ssh_steps(plan: &crate::ssh::Plan, r: &mut Report) -> bool {
    let t0 = Instant::now();
    let tunnel = match plan.tunnel() {
        Ok(t) => t,
        Err(e) => {
            let text = e.to_string();
            let hint = ssh_hint(&text);
            r.fail("ssh", "Túnel SSH", t0, text, hint);
            return false;
        }
    };
    r.step("ssh", "Túnel SSH", "ok", ms(t0), format!("{} · puerto local {}", tunnel.summary, tunnel.local_port));
    let t1 = Instant::now();
    let label = format!("Reenvío a {}", tunnel.target_label());
    match tunnel.check_forward() {
        Ok(()) => {
            r.step("forward", &label, "ok", ms(t1), "el servidor SSH llega al servidor de la base");
            true
        }
        Err(e) => {
            let hint = format!(
                "El túnel SSH está bien, pero el servidor SSH no llega a {}: revisa el servidor y el puerto de la base tal y como los ve el servidor SSH («localhost» es el propio servidor SSH) y que su configuración permita reenviar puertos (AllowTcpForwarding).",
                tunnel.target_label()
            );
            r.fail("forward", &label, t1, e.to_string(), hint);
            false
        }
    }
}

fn ssh_hint(error: &str) -> String {
    let m = error.to_lowercase();
    if error.starts_with("SSH_HOST_UNKNOWN:") {
        "Es la primera vez que Celer ve este servidor SSH: compara la huella con la que te dé quien lo administra y, si coincide, pulsa «Confiar en esta clave».".into()
    } else if error.starts_with("SSH_HOST_CHANGED:") {
        "La clave del servidor SSH no es la que Celer guardó: no se conecta hasta saber por qué (un servidor reinstalado o alguien en medio).".into()
    } else if m.contains("no aceptó la autenticación") {
        "El servidor SSH rechazó el usuario o la credencial: revisa usuario, contraseña o clave (y que la clave pública esté en ~/.ssh/authorized_keys del servidor).".into()
    } else if m.contains("refused") || m.contains("os error 10061") || m.contains("os error 111") {
        "Nadie escucha en el puerto SSH: revisa el servidor y el puerto SSH (normalmente 22) y que sshd esté en marcha.".into()
    } else if m.contains("no contesta") || m.contains("timed out") {
        "El servidor SSH no contesta: un cortafuegos, la VPN desconectada o el servidor apagado.".into()
    } else if m.contains("failed to lookup") || m.contains("name or service not known") || m.contains("no such host") || m.contains("nodename nor servname") {
        "No se encuentra el nombre del servidor SSH: revisa cómo está escrito o usa su dirección IP.".into()
    } else {
        String::new()
    }
}

/// SQLite: el fichero (se crea al conectar si no existe).
fn file_step(cfg: &ConnConfig, r: &mut Report) {
    let t0 = Instant::now();
    let path = cfg.file_path.trim();
    let detail = if path.is_empty() || path == ":memory:" {
        "base en memoria".to_string()
    } else if std::path::Path::new(path).exists() {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        format!("{path} ({} KB)", size.div_ceil(1024))
    } else {
        format!("{path} no existe: se creará al conectar")
    };
    r.step("resolve", "Fichero", "ok", ms(t0), detail);
}

/// Resolver el nombre y abrir el puerto (y TLS cuando se puede ver aparte). Devuelve si se puede seguir.
fn network_steps(cfg: &ConnConfig, r: &mut Report) -> bool {
    let raw = cfg.host.trim();
    let raw = if raw.is_empty() { "localhost" } else { raw };
    // SQL Server admite «servidor\instancia» en el campo del servidor.
    let (host, instance_in_host) = match raw.split_once('\\') {
        Some((h, i)) if cfg.kind == DbKind::Mssql => (h, i),
        _ => (raw, ""),
    };
    let named = cfg.kind == DbKind::Mssql && cfg.port.is_none() && (!cfg.instance.trim().is_empty() || !instance_in_host.is_empty());
    let port = cfg.port.unwrap_or_else(|| default_port(cfg));

    let t0 = Instant::now();
    let resolved: std::io::Result<Vec<SocketAddr>> = (host, port).to_socket_addrs().map(|a| a.collect());
    let addrs = match resolved {
        Ok(a) if !a.is_empty() => a,
        Ok(_) => {
            r.fail("resolve", "Resolver el nombre", t0, format!("{host}: sin direcciones"), dns_hint(host));
            return false;
        }
        Err(e) => {
            r.fail("resolve", "Resolver el nombre", t0, format!("{host}: {e}"), dns_hint(host));
            return false;
        }
    };
    let mut ips: Vec<String> = Vec::new();
    for a in &addrs {
        let ip = a.ip().to_string();
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    let detail = if host.parse::<IpAddr>().is_ok() { format!("{host} (dirección IP, sin DNS)") } else { format!("{host} → {}", ips.join(", ")) };
    r.step("resolve", "Resolver el nombre", "ok", ms(t0), detail);

    if named {
        r.step("tcp", "Abrir el puerto", "skipped", 0, "Instancia con nombre: el puerto lo da SQL Server Browser (UDP 1434) al iniciar sesión");
        r.step("tls", "TLS", "skipped", 0, mssql_tls_note(cfg));
        return true;
    }

    let t1 = Instant::now();
    let mut opened: Option<(TcpStream, SocketAddr)> = None;
    let mut last: Option<std::io::Error> = None;
    for a in &addrs {
        match TcpStream::connect_timeout(a, STEP_TIMEOUT) {
            Ok(s) => {
                opened = Some((s, *a));
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let Some((stream, addr)) = opened else {
        let e = last.unwrap_or_else(|| std::io::Error::other("sin direcciones"));
        let hint = match e.kind() {
            ErrorKind::ConnectionRefused => format!(
                "El servidor existe, pero nadie escucha en el puerto {port}: revisa el puerto{} y que el servicio esté arrancado.",
                match cfg.kind {
                    DbKind::Mssql => " (y que SQL Server tenga TCP/IP habilitado)",
                    DbKind::Informix => " (SQLI suele ser 9088 y DRDA 9089)",
                    _ => "",
                }
            ),
            ErrorKind::TimedOut | ErrorKind::WouldBlock => format!(
                "{host}:{port} no contesta en {} s: un cortafuegos que lo bloquea, la VPN desconectada o el servidor apagado.",
                STEP_TIMEOUT.as_secs()
            ),
            _ => "No se pudo abrir la conexión de red con el servidor: revisa el servidor, el puerto y la red (VPN).".to_string(),
        };
        r.fail("tcp", "Abrir el puerto", t1, format!("{host}:{port}: {e}"), hint);
        return false;
    };
    r.step("tcp", "Abrir el puerto", "ok", ms(t1), format!("{addr} abierto"));

    match cfg.kind {
        DbKind::Postgres => pg_tls(cfg, host, stream, r),
        DbKind::Mysql => mysql_greeting(cfg, stream, r),
        DbKind::Mssql => {
            r.step("tls", "TLS", "skipped", 0, mssql_tls_note(cfg));
            true
        }
        _ => {
            r.step("tls", "TLS", "skipped", 0, "Esta conexión no usa TLS");
            true
        }
    }
}

fn dns_hint(host: &str) -> String {
    format!("No se encuentra el servidor «{host}»: revisa el nombre y, si es de la red de la empresa, que la VPN esté conectada.")
}

fn mssql_tls_note(cfg: &ConnConfig) -> String {
    match cfg.encryption.as_str() {
        "off" => "Sin cifrar (desactivado en la conexión)".into(),
        "login" => "Solo el inicio de sesión va cifrado; SQL Server lo negocia dentro del inicio de sesión (TDS)".into(),
        _ => "SQL Server negocia TLS dentro del inicio de sesión (TDS): su tiempo va en «Inicio de sesión»".into(),
    }
}

/// PostgreSQL: SSLRequest y, si el servidor acepta, el apretón de manos TLS.
fn pg_tls(cfg: &ConnConfig, host: &str, mut stream: TcpStream, r: &mut Report) -> bool {
    let from_extra = cfg
        .extra
        .split([';', '\n', '\r'])
        .filter_map(|p| p.split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("sslmode"))
        .map(|(_, v)| v.trim().trim_matches('\'').to_ascii_lowercase());
    let mode = from_extra.unwrap_or_else(|| crate::postgres::sslmode(&cfg.encryption).to_string());
    if matches!(mode.as_str(), "disable" | "allow") {
        r.step("tls", "TLS", "skipped", 0, "Desactivado en la conexión");
        return true;
    }
    let required = mode != "prefer";
    let t0 = Instant::now();
    let _ = stream.set_read_timeout(Some(STEP_TIMEOUT));
    let _ = stream.set_write_timeout(Some(STEP_TIMEOUT));
    // SSLRequest: longitud 8 y el código 80877103.
    let mut answer = [0u8; 1];
    let asked = stream.write_all(&[0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]).and_then(|_| stream.read_exact(&mut answer));
    if let Err(e) = asked {
        r.fail("tls", "TLS", t0, format!("El servidor no contestó a la petición de TLS: {e}"), "No parece un servidor PostgreSQL: revisa el puerto.".into());
        return false;
    }
    match answer[0] {
        b'S' => {
            let mut builder = native_tls::TlsConnector::builder();
            if cfg.trust_cert {
                builder.danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true);
            }
            let tls = match builder.build() {
                Ok(t) => t,
                Err(e) => {
                    r.fail("tls", "TLS", t0, e.to_string(), String::new());
                    return false;
                }
            };
            match tls.connect(host, stream) {
                Ok(_) => {
                    let detail = if cfg.trust_cert { "Cifrado aceptado (certificado sin comprobar: «Confiar en el certificado»)".to_string() } else { format!("Cifrado aceptado; certificado válido para «{host}»") };
                    r.step("tls", "TLS", "ok", ms(t0), detail);
                    true
                }
                Err(e) => {
                    r.fail("tls", "TLS", t0, e.to_string(), "El servidor no aceptó el cifrado o su certificado: si es autofirmado, marca «Confiar en el certificado»; si no, cambia el cifrado a «Preferido».".into());
                    false
                }
            }
        }
        b'N' if required => {
            r.fail("tls", "TLS", t0, "El servidor no admite TLS".into(), "Cambia el cifrado a «Preferido» o «Desactivado», o activa ssl en el servidor.".into());
            false
        }
        b'N' => {
            r.step("tls", "TLS", "skipped", ms(t0), "El servidor no cifra: la conexión irá sin TLS");
            true
        }
        other => {
            r.fail("tls", "TLS", t0, format!("Respuesta inesperada a la petición de TLS ({other})"), "No parece un servidor PostgreSQL: revisa el puerto.".into());
            false
        }
    }
}

/// MySQL / MariaDB: el servidor habla primero. Su saludo dice la versión y si admite TLS (que se negocia al iniciar
/// sesión); un paquete de error aquí es un rechazo antes del login (ERROR 1130: este equipo no tiene permiso).
fn mysql_greeting(cfg: &ConnConfig, mut stream: TcpStream, r: &mut Report) -> bool {
    let t0 = Instant::now();
    let _ = stream.set_read_timeout(Some(STEP_TIMEOUT));
    let mut head = [0u8; 4];
    let mut body: Vec<u8> = Vec::new();
    let read = stream.read_exact(&mut head).and_then(|_| {
        let len = head[0] as usize | (head[1] as usize) << 8 | (head[2] as usize) << 16;
        body = vec![0u8; len.min(1 << 16)];
        stream.read_exact(&mut body)
    });
    if let Err(e) = read {
        r.fail("tls", "Saludo del servidor", t0, e.to_string(), "El servidor no habla el protocolo de MySQL en ese puerto, o cerró la conexión: revisa el puerto.".into());
        return false;
    }
    if body.first() == Some(&0xFF) {
        let code = u16::from_le_bytes([body.get(1).copied().unwrap_or(0), body.get(2).copied().unwrap_or(0)]);
        let from = if body.get(3) == Some(&b'#') { 9 } else { 3 };
        let message = String::from_utf8_lossy(body.get(from..).unwrap_or(&[])).to_string();
        let hint = match code {
            1130 => "El servidor no admite conexiones desde este equipo (ERROR 1130): hay que dar permiso al usuario desde este host.",
            1129 => "El servidor ha bloqueado este equipo por demasiados intentos de conexión fallidos (ERROR 1129): un administrador debe ejecutar FLUSH HOSTS.",
            1040 => "El servidor ha llegado a su máximo de conexiones: inténtalo más tarde o cierra sesiones.",
            _ => "",
        };
        r.fail("tls", "Saludo del servidor", t0, format!("ERROR {code}: {message}"), hint.into());
        return false;
    }
    // Saludo v10: versión terminada en 0, id de conexión (4), 8 bytes, relleno (1) y capacidades bajas (2).
    let nul = body.iter().skip(1).position(|&b| b == 0).map(|p| p + 1);
    let version = nul.map(|n| String::from_utf8_lossy(&body[1..n]).to_string()).unwrap_or_default();
    let ssl = nul
        .map(|n| n + 1 + 4 + 8 + 1)
        .and_then(|at| body.get(at..at + 2))
        .is_some_and(|b| u16::from_le_bytes([b[0], b[1]]) & 0x0800 != 0);
    let server = if version.is_empty() { "El servidor".to_string() } else { format!("El servidor ({version})") };
    let mode = cfg.encryption.trim().to_ascii_lowercase();
    let (off, preferred) = (matches!(mode.as_str(), "off" | "disable" | "disabled" | "false" | "no"), matches!(mode.as_str(), "login" | "preferred" | "prefer"));
    if off {
        r.step("tls", "TLS", "skipped", ms(t0), format!("Desactivado en la conexión · {server} contestó"));
    } else if ssl {
        r.step("tls", "TLS", "ok", ms(t0), format!("{server} admite TLS: se negocia al iniciar sesión"));
    } else if preferred {
        r.step("tls", "TLS", "skipped", ms(t0), format!("{server} no admite TLS: la conexión irá sin cifrar"));
    } else {
        r.fail("tls", "TLS", t0, format!("{server} no admite TLS"), "Cambia el cifrado a «Preferido» o «Desactivado».".into());
        return false;
    }
    true
}

/// Qué significa un error al conectar y qué hacer, en palabras llanas ("" si no se sabe).
pub fn explain(cfg: &ConnConfig, error: &str) -> String {
    // Informix: la guía ya lo explica (código INFORMIX_GUIDE:tema: explicación\n\nerror).
    if let Some(rest) = error.strip_prefix("INFORMIX_GUIDE:") {
        let what = rest.split_once(": ").map(|(_, w)| w).unwrap_or(rest);
        return what.split("\n\n").next().unwrap_or("").trim().to_string();
    }
    let m = error.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| m.contains(w));
    if has(&["script de inicio"]) {
        return "Falló el script al conectar (Opciones avanzadas): corrígelo o vacíalo.".into();
    }
    if has(&["no pg_hba.conf entry"]) {
        return "PostgreSQL no tiene una regla en pg_hba.conf para este equipo, usuario y base (o exige TLS): pide que la añadan o cambia el cifrado.".into();
    }
    if has(&["28p01", "password authentication failed", "(1045)", "error 1045", "access denied for user", "login failed", "msg 18456", "-951", "-952", "sql30082n", "usuario o contraseña"]) {
        return "Usuario o contraseña incorrectos, o el usuario no puede entrar desde este equipo. Revísalos (en SQL Server, también que el servidor admita la autenticación de SQL Server).".into();
    }
    if has(&["3d000", "(1049)", "error 1049", "unknown database", "msg 4060", "cannot open database", "-329", "database not found"]) || (m.contains("database") && m.contains("does not exist")) {
        return "La base de datos no existe o el usuario no puede abrirla: revisa el nombre (o déjalo vacío para usar la predeterminada).".into();
    }
    if has(&["certificate", "certificado", "ssl", "tls", "handshake"]) {
        return "Falló el cifrado: si el servidor usa un certificado autofirmado, marca «Confiar en el certificado»; si no admite TLS, cambia el cifrado a «Preferido» o «Desactivado».".into();
    }
    if has(&["(1130)", "error 1130", "is not allowed to connect"]) {
        return "El servidor no admite conexiones desde este equipo con ese usuario: hay que darle permiso desde este host.".into();
    }
    if has(&["too many connections", "(1040)", "53300", "remaining connection slots"]) {
        return "El servidor ha llegado a su máximo de conexiones: inténtalo más tarde o cierra sesiones.".into();
    }
    if has(&["refused", "10061", "os error 111"]) {
        return "Nadie escucha en ese servidor y puerto: revisa el puerto y que el servicio esté arrancado.".into();
    }
    if has(&["timed out", "tiempo de espera", "10060", "timeout"]) {
        return "El servidor no contesta: un cortafuegos, la VPN desconectada o el servidor apagado. Si responde despacio, prueba otra vez.".into();
    }
    if has(&["no such host", "name or service not known", "11001", "failed to lookup", "nodename nor servname", "no se encuentra el servidor"]) {
        return dns_hint(cfg.host.trim());
    }
    if has(&["starting up", "57p03", "40613", "is not currently available"]) {
        return "El servidor está arrancando o no está disponible ahora: espera unos segundos y prueba otra vez.".into();
    }
    if cfg.kind == DbKind::Odbc && has(&["im014", "architecture mismatch"]) {
        return "El DSN usa un driver de 32 bits y Celer es de 64 bits: crea el DSN con «Orígenes de datos ODBC (64 bits)», con la versión de 64 bits del driver.".into();
    }
    if cfg.kind == DbKind::Odbc && has(&["im002", "data source name not found"]) {
        if let Some(hint) = odbc_name(&cfg.odbc_conn_str).and_then(|(what, name)| bitness_hint(what, &name, odbc_installed(what, &name))) {
            return hint;
        }
        return "No existe ese origen de datos (DSN) ni ese driver ODBC en este equipo: revisa la cadena de conexión.".into();
    }
    String::new()
}

/// Lo que nombra una cadena ODBC: un driver (`DRIVER={…}`) o un DSN (`DSN=…`), con su nombre.
#[derive(Clone, Copy, Debug, PartialEq)]
enum OdbcName {
    Driver,
    Dsn,
}

fn odbc_name(conn: &str) -> Option<(OdbcName, String)> {
    let mut dsn = None;
    for part in conn.split(';') {
        let Some((key, value)) = part.split_once('=') else { continue };
        let value = value.trim().trim_start_matches('{').trim_end_matches('}').trim().to_string();
        match key.trim().to_ascii_uppercase().as_str() {
            "DRIVER" if !value.is_empty() => return Some((OdbcName::Driver, value)),
            "DSN" if !value.is_empty() => dsn = Some((OdbcName::Dsn, value)),
            _ => {}
        }
    }
    dsn
}

/// Dónde está registrado un driver o DSN en este Windows: (en 64 bits, solo para 32 bits). Los DSN de usuario son
/// de las dos vistas del registro: cuentan como de 64 bits (el error dice entonces que su driver no lo es).
#[cfg(windows)]
fn odbc_installed(what: OdbcName, name: &str) -> (bool, bool) {
    use winreg::{enums::*, RegKey};
    let ini = match what {
        OdbcName::Driver => "ODBCINST.INI",
        OdbcName::Dsn => "ODBC.INI",
    };
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let found = |root: &RegKey, path: String| root.open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY).is_ok();
    let native = found(&hklm, format!(r"SOFTWARE\ODBC\{ini}\{name}"))
        || (what == OdbcName::Dsn && found(&RegKey::predef(HKEY_CURRENT_USER), format!(r"SOFTWARE\ODBC\ODBC.INI\{name}")));
    let wow = found(&hklm, format!(r"SOFTWARE\WOW6432Node\ODBC\{ini}\{name}"));
    (native, wow)
}

#[cfg(not(windows))]
fn odbc_installed(_: OdbcName, _: &str) -> (bool, bool) {
    (false, false)
}

/// Un driver o DSN que solo está en la parte de 32 bits del registro (o un DSN cuyo driver no es de 64 bits).
fn bitness_hint(what: OdbcName, name: &str, (native, wow): (bool, bool)) -> Option<String> {
    match (what, native, wow) {
        (OdbcName::Driver, false, true) => Some(format!(
            "El driver «{name}» solo está instalado en 32 bits (HKLM\\SOFTWARE\\WOW6432Node\\ODBC): Celer es de 64 bits y necesita la versión de 64 bits del driver."
        )),
        (OdbcName::Dsn, false, true) => Some(format!(
            "El DSN «{name}» solo existe en 32 bits (se creó con «Orígenes de datos ODBC (32 bits)»): Celer es de 64 bits; créalo en «Orígenes de datos ODBC (64 bits)», con la versión de 64 bits de su driver."
        )),
        (OdbcName::Dsn, true, _) => Some(format!(
            "El DSN «{name}» existe, pero su driver no está instalado en 64 bits: Celer es de 64 bits y necesita la versión de 64 bits del driver."
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(kind: DbKind) -> ConnConfig {
        ConnConfig { kind, host: "db.example.com".into(), ..Default::default() }
    }

    #[test]
    fn errors_explained() {
        let pg = cfg(DbKind::Postgres);
        assert!(explain(&pg, "db error: FATAL: password authentication failed for user \"x\"").starts_with("Usuario o contraseña"));
        assert!(explain(&pg, "db error: FATAL: database \"ventas\" does not exist").starts_with("La base de datos no existe"));
        assert!(explain(&pg, "db error: FATAL: no pg_hba.conf entry for host").contains("pg_hba.conf"));
        let ms = cfg(DbKind::Mssql);
        assert!(explain(&ms, "Msg 18456, nivel 14, línea 1: Login failed for user 'sa'.").starts_with("Usuario o contraseña"));
        assert!(explain(&ms, "Msg 4060, nivel 11, línea 1: Cannot open database \"x\" requested by the login.").starts_with("La base de datos"));
        let my = cfg(DbKind::Mysql);
        assert!(explain(&my, "ERROR 1045 (28000): Access denied for user 'root'@'10.0.0.1'").starts_with("Usuario o contraseña"));
        let ifx = cfg(DbKind::Informix);
        assert_eq!(explain(&ifx, "INFORMIX_GUIDE:server: Revisa el campo INFORMIXSERVER.\n\n[08001] -25596"), "Revisa el campo INFORMIXSERVER.");
        assert_eq!(explain(&pg, "algo raro"), "");
    }

    #[test]
    fn a_closed_port_fails_at_the_port_step() {
        // A port nobody listens on, on this machine: the name resolves and the port refuses.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut c = cfg(DbKind::Postgres);
        c.host = "127.0.0.1".into();
        c.port = Some(port);
        let connector: Connector = std::sync::Arc::new(|| -> anyhow::Result<Box<dyn crate::session::Driver>> { anyhow::bail!("no debía llegar a conectar") });
        let r = run(&c, connector, "", None);
        assert!(!r.ok);
        let ids: Vec<&str> = r.steps.iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["resolve", "tcp"], "{:?}", r.steps);
        assert_eq!(r.steps[1].status, "failed");
        assert!(r.hint.contains("nadie escucha"), "{}", r.hint);
    }

    #[test]
    fn odbc_drivers_of_32_bits() {
        assert_eq!(odbc_name("DRIVER={Microsoft Access Driver (*.mdb)};DBQ=C:\\x.mdb"), Some((OdbcName::Driver, "Microsoft Access Driver (*.mdb)".into())));
        assert_eq!(odbc_name(" dsn = Ventas ; UID=u"), Some((OdbcName::Dsn, "Ventas".into())));
        assert_eq!(odbc_name("FILEDSN=c:\\x.dsn"), None);
        let hint = |what, native, wow| bitness_hint(what, "X", (native, wow)).unwrap_or_default();
        assert!(hint(OdbcName::Driver, false, true).contains("solo está instalado en 32 bits"));
        assert!(hint(OdbcName::Dsn, false, true).contains("solo existe en 32 bits"));
        assert!(hint(OdbcName::Dsn, true, false).contains("no está instalado en 64 bits"));
        assert_eq!(hint(OdbcName::Driver, false, false), "", "not installed at all: the usual message");
        assert_eq!(hint(OdbcName::Driver, true, true), "");
        let mut odbc = cfg(DbKind::Odbc);
        odbc.odbc_conn_str = "DRIVER={Celer driver that does not exist};".into();
        assert!(explain(&odbc, "[IM002] [Microsoft][ODBC Driver Manager] Data source name not found and no default driver specified").starts_with("No existe ese origen"));
        assert!(explain(&odbc, "[IM014] [Microsoft][ODBC Driver Manager] The specified DSN contains an architecture mismatch between the Driver and Application").contains("64 bits"));
    }

    #[test]
    fn a_missing_database_fails_the_database_step() {
        let mut c = cfg(DbKind::Odbc);
        c.user = "app".into();
        for error in ["db error: FATAL: database \"no_such_db\" does not exist", "ERROR 1049 (42000): Unknown database 'no_such_db'", "Msg 4060, nivel 11, línea 1: Cannot open database \"x\" requested by the login."] {
            let text = error.to_string();
            let connector: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn crate::session::Driver>> { anyhow::bail!("{text}") });
            let r = run(&c, connector, "", None);
            let steps: Vec<(&str, &str)> = r.steps.iter().map(|s| (s.id, s.status)).collect();
            assert_eq!(steps, vec![("login", "ok"), ("database", "failed")], "{error}");
            assert!(!r.ok && r.hint.starts_with("La base de datos"), "{}", r.hint);
        }
        let connector: Connector = std::sync::Arc::new(|| -> anyhow::Result<Box<dyn crate::session::Driver>> { anyhow::bail!("password authentication failed for user \"app\"") });
        let r = run(&c, connector, "", None);
        assert_eq!(r.steps.iter().map(|s| (s.id, s.status)).collect::<Vec<_>>(), vec![("login", "failed")]);
    }

    #[test]
    fn a_missing_postgres_database_fails_the_database_step() {
        let Some(spec) = std::env::var("CELER_PG_TEST").ok() else { return };
        let mut c = ConnConfig { kind: DbKind::Postgres, encryption: "off".into(), ..Default::default() };
        for part in spec.split_whitespace() {
            match part.split_once('=') {
                Some(("host", v)) => c.host = v.into(),
                Some(("port", v)) => c.port = v.parse().ok(),
                Some(("user", v)) => c.user = v.into(),
                Some(("password", v)) => c.password = Some(v.into()),
                _ => {}
            }
        }
        c.database = "no_such_db".into();
        let cfg = c.clone();
        let connector: Connector = std::sync::Arc::new(move || -> anyhow::Result<Box<dyn crate::session::Driver>> { Ok(Box::new(crate::postgres::PostgresDriver::connect(cfg.clone())?)) });
        let r = run(&c, connector, "", None);
        let login = r.steps.iter().find(|s| s.id == "login").unwrap();
        let database = r.steps.iter().find(|s| s.id == "database").unwrap();
        assert_eq!((login.status, database.status), ("ok", "failed"), "{:?} {}", r.steps, r.error);
    }

    #[test]
    fn mysql_greeting_says_whether_tls_is_offered() {
        // A fake MySQL 8 greeting with CLIENT_SSL, then the step reads it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut payload = vec![10u8];
            payload.extend_from_slice(b"8.0.36\0");
            payload.extend_from_slice(&[1, 0, 0, 0]);
            payload.extend_from_slice(&[0u8; 8]);
            payload.push(0);
            payload.extend_from_slice(&(0x0800u16 | 0x0200).to_le_bytes());
            let mut packet = vec![payload.len() as u8, 0, 0, 0];
            packet.extend_from_slice(&payload);
            s.write_all(&packet).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut r = Report::default();
        let mut c = cfg(DbKind::Mysql);
        c.encryption = "required".into();
        assert!(mysql_greeting(&c, stream, &mut r));
        assert_eq!(r.steps[0].status, "ok");
        assert!(r.steps[0].detail.contains("8.0.36") && r.steps[0].detail.contains("admite TLS"), "{:?}", r.steps);
        server.join().unwrap();
    }
}
