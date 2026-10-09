//! SSH tunnels: a connection that is only reachable through a bastion goes through local port forwarding.
//!
//! - **One tunnel per connection**, shared by all its sessions (explorer, consoles, exports, the pool's free
//!   connections): Celer logs in to the SSH server (through the jump hosts, in order), listens on a free port of
//!   127.0.0.1 and forwards each connection made there to the database server, as the SSH server sees it.
//! - **Reconnection**: the drivers connect through `Plan::tunnel`, which rebuilds the tunnel when its SSH session is
//!   gone; the session guard (guard.rs) reconnects a dropped session through the same connector, so a restarted
//!   bastion is crossed again on the next query.
//! - **Host keys are never accepted silently**: a key Celer has not seen fails with `SSH_HOST_UNKNOWN:<token>:` (the
//!   interface shows its fingerprint and «Confiar en esta clave» calls `trust`), and a key that differs from the one
//!   kept fails with `SSH_HOST_CHANGED:`. Keys are kept in `known_hosts` in Celer's data folder (OpenSSH format); the
//!   user's `~/.ssh/known_hosts` is read too, never written.
//! - Tunnels nobody uses are closed after a while (`IDLE_CLOSE`).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use russh::client;
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyBase64};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::model::{ConnConfig, DbKind, SshConfig};

/// How long logging in to one SSH server may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A tunnel without forwarded connections is closed after this long.
const IDLE_CLOSE: Duration = Duration::from_secs(120);
/// SSH keepalives: a bastion that stops answering is noticed in about a minute.
const KEEPALIVE: Duration = Duration::from_secs(15);

// ───────────────────────────────────────────────────────────────── configuration

/// One SSH server on the way: the jump hosts, then the SSH server itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hop {
    pub user: String,
    pub host: String,
    pub port: u16,
}

impl Hop {
    pub fn label(&self) -> String {
        format!("{}@{}", self.user, host_port(&self.host, self.port))
    }
}

fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn parse_port(text: &str, whole: &str) -> Result<u16> {
    text.trim().parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| anyhow!("«{whole}»: el puerto tiene que ser un número entre 1 y 65535"))
}

/// `user@host:port`, `host`, `host:port` or `[2001:db8::1]:2222` → a hop; the user defaults to the SSH server's and
/// the port to 22.
pub fn parse_hop(text: &str, default_user: &str) -> Result<Hop> {
    let whole = text.trim();
    if whole.is_empty() {
        bail!("falta el servidor");
    }
    let (user, rest) = match whole.rsplit_once('@') {
        Some((user, rest)) => (user.trim().to_string(), rest.trim()),
        None => (default_user.trim().to_string(), whole),
    };
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        let (host, after) = inner.split_once(']').ok_or_else(|| anyhow!("«{whole}»: falta el «]» de la dirección IPv6"))?;
        match after.strip_prefix(':') {
            Some(port) => (host.to_string(), parse_port(port, whole)?),
            None if after.is_empty() => (host.to_string(), 22),
            None => bail!("«{whole}»: después de «]» solo puede ir «:puerto»"),
        }
    } else if rest.matches(':').count() == 1 {
        let (host, port) = rest.split_once(':').unwrap_or((rest, "22"));
        (host.to_string(), parse_port(port, whole)?)
    } else {
        // A bare IPv6 address (several ':') or a name without port.
        (rest.to_string(), 22)
    };
    if host.trim().is_empty() || host.contains(char::is_whitespace) {
        bail!("«{whole}»: falta el servidor o lleva espacios");
    }
    if user.is_empty() {
        bail!("«{whole}»: falta el usuario");
    }
    Ok(Hop { user, host: host.trim().to_string(), port })
}

/// Every SSH server of the tunnel, in the order they are crossed: the jump hosts, then the SSH server.
pub fn hops(ssh: &SshConfig) -> Result<Vec<Hop>> {
    let user = ssh.user.trim();
    let host = ssh.host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        bail!("SSH: falta el servidor SSH");
    }
    if user.is_empty() {
        bail!("SSH: falta el usuario SSH");
    }
    let mut out = Vec::new();
    for jump in ssh.jumps.iter().filter(|j| !j.trim().is_empty()) {
        out.push(parse_hop(jump, user).map_err(|e| anyhow!("SSH: salto {e}"))?);
    }
    out.push(Hop { user: user.to_string(), host: host.to_string(), port: ssh.port.unwrap_or(22) });
    Ok(out)
}

fn default_port(kind: DbKind, informix_mode: &str) -> u16 {
    match kind {
        DbKind::Postgres => 5432,
        DbKind::Mysql => 3306,
        DbKind::Mssql => 1433,
        DbKind::Informix if informix_mode == "drda" => 9089,
        _ => 9088,
    }
}

/// Where the tunnel goes: the database server and port as the SSH server reaches them ("localhost" is the SSH server
/// itself). A SQL Server named instance needs its port: SQL Server Browser (UDP 1434) does not cross a tunnel.
pub fn target(cfg: &ConnConfig) -> Result<(String, u16)> {
    let raw = cfg.host.trim();
    let raw = if raw.is_empty() { "localhost" } else { raw };
    let (host, instance_in_host) = match raw.split_once('\\') {
        Some((host, instance)) if cfg.kind == DbKind::Mssql => (host, instance),
        _ => (raw, ""),
    };
    let port = match cfg.port {
        Some(port) => port,
        None if cfg.kind == DbKind::Mssql && (!instance_in_host.is_empty() || !cfg.instance.trim().is_empty()) => bail!(
            "SSH: por un túnel SSH una instancia con nombre de SQL Server necesita su puerto (SQL Server Browser, UDP 1434, no cruza el túnel). Escribe el puerto de la instancia."
        ),
        None => default_port(cfg.kind, &cfg.informix_mode),
    };
    Ok((host.trim_start_matches('[').trim_end_matches(']').to_string(), port))
}

// ───────────────────────────────────────────────────────────────── known hosts

/// What the known_hosts files say about a server's key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKey {
    Known,
    Unknown,
    /// Another key is kept for that server: where.
    Changed(String),
}

/// Celer's own known_hosts (written when the user trusts a key) and the user's OpenSSH one (only read).
#[derive(Debug, Clone)]
pub struct KnownHosts {
    pub own: PathBuf,
    pub user: Option<PathBuf>,
}

impl KnownHosts {
    pub fn new(data_dir: &Path) -> KnownHosts {
        KnownHosts { own: data_dir.join("known_hosts"), user: dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts")) }
    }

    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKey {
        let mut known = false;
        for path in std::iter::once(&self.own).chain(self.user.as_ref()) {
            match keys::check_known_hosts_path(host, port, key, path) {
                Ok(true) => known = true,
                Ok(false) => {}
                Err(keys::Error::KeyChanged { line }) => return HostKey::Changed(format!("{}, línea {line}", path.display())),
                // A file that cannot be read says nothing about this server.
                Err(_) => {}
            }
        }
        if known {
            HostKey::Known
        } else {
            HostKey::Unknown
        }
    }

    pub fn learn(&self, host: &str, port: u16, key: &PublicKey) -> Result<()> {
        keys::known_hosts::learn_known_hosts_path(host, port, key, &self.own).map_err(|e| anyhow!("No se pudo guardar la clave en {}: {e}", self.own.display()))
    }
}

/// A host key the user was shown and has not trusted yet.
struct Pending {
    host: String,
    port: u16,
    key: PublicKey,
}

/// What the interface shows to trust a host key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn key_type(key: &PublicKey) -> String {
    key.algorithm().as_str().to_string()
}

/// Keeps an unknown key for `trust` and returns its token (the same for the same server and key).
fn remember(host: &str, port: u16, key: &PublicKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{host}\n{port}\n{}", key.public_key_base64()).as_bytes());
    let token: String = hasher.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    pending().lock().insert(token.clone(), Pending { host: host.to_string(), port, key: key.clone() });
    token
}

pub fn pending_info(token: &str) -> Option<HostKeyInfo> {
    pending().lock().get(token).map(|p| HostKeyInfo { host: p.host.clone(), port: p.port, key_type: key_type(&p.key), fingerprint: fingerprint(&p.key) })
}

/// «Confiar en esta clave»: the key shown under `token` goes to Celer's known_hosts.
pub fn trust(data_dir: &Path, token: &str) -> Result<HostKeyInfo> {
    let p = pending().lock().remove(token).ok_or_else(|| anyhow!("Esa clave ya no está pendiente: vuelve a conectar para verla otra vez"))?;
    let known = KnownHosts::new(data_dir);
    if let HostKey::Changed(at) = known.check(&p.host, p.port, &p.key) {
        bail!("Ya hay otra clave guardada para {} ({at}): Celer no la sustituye", host_port(&p.host, p.port));
    }
    known.learn(&p.host, p.port, &p.key)?;
    Ok(HostKeyInfo { host: p.host.clone(), port: p.port, key_type: key_type(&p.key), fingerprint: fingerprint(&p.key) })
}

/// The error of a host key that is not known (`Unknown`) or that changed.
fn key_error(hop: &Hop, verdict: &HostKey, key: &PublicKey) -> anyhow::Error {
    let server = host_port(&hop.host, hop.port);
    let print = format!("{} {}", key_type(key), fingerprint(key));
    match verdict {
        HostKey::Changed(at) => anyhow!(
            "SSH_HOST_CHANGED: La clave del servidor SSH {server} ha cambiado ({print}) y no coincide con la guardada ({at}). Puede ser alguien en medio de la conexión o un servidor reinstalado: Celer no conecta. Si el cambio es legítimo, borra esa línea y vuelve a conectar."
        ),
        _ => {
            let token = remember(&hop.host, hop.port, key);
            anyhow!("SSH_HOST_UNKNOWN:{token}: Celer no conoce la clave del servidor SSH {server} ({print}). Compruébala con quien administra el servidor y pulsa «Confiar en esta clave».")
        }
    }
}

// ───────────────────────────────────────────────────────────────── SSH sessions

type Verdict = Arc<Mutex<Option<(HostKey, PublicKey)>>>;

/// Checks the server's key against the known_hosts files; only a known key goes on.
struct Checker {
    host: String,
    port: u16,
    known: Arc<KnownHosts>,
    verdict: Verdict,
}

impl client::Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = key.public_key();
        let verdict = self.known.check(&self.host, self.port, &key);
        let ok = verdict == HostKey::Known;
        *self.verdict.lock() = Some((verdict, key));
        Ok(ok)
    }
}

type Session = client::Handle<Checker>;

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config { inactivity_timeout: None, keepalive_interval: Some(KEEPALIVE), keepalive_max: 4, ..Default::default() })
}

/// Logs in to one SSH server: directly, or through the session of the previous hop.
async fn connect_hop(prev: Option<&Session>, hop: &Hop, ssh: &SshConfig, known: &Arc<KnownHosts>) -> Result<(Session, String)> {
    let verdict: Verdict = Arc::new(Mutex::new(None));
    let checker = Checker { host: hop.host.clone(), port: hop.port, known: known.clone(), verdict: verdict.clone() };
    let connected = match prev {
        None => tokio::time::timeout(CONNECT_TIMEOUT, client::connect(ssh_config(), (hop.host.as_str(), hop.port), checker)).await,
        Some(prev) => {
            let channel = prev
                .channel_open_direct_tcpip(hop.host.clone(), hop.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| anyhow!("SSH: el salto anterior no pudo abrir la conexión con {}: {e}", host_port(&hop.host, hop.port)))?;
            tokio::time::timeout(CONNECT_TIMEOUT, client::connect_stream(ssh_config(), channel.into_stream(), checker)).await
        }
    };
    let mut session = match connected {
        Err(_) => bail!("SSH: {} no contesta en {} s", host_port(&hop.host, hop.port), CONNECT_TIMEOUT.as_secs()),
        Ok(Ok(session)) => session,
        Ok(Err(e)) => {
            if let Some((verdict, key)) = verdict.lock().take() {
                if verdict != HostKey::Known {
                    return Err(key_error(hop, &verdict, &key));
                }
            }
            bail!("SSH: no se pudo conectar con {}: {e}", host_port(&hop.host, hop.port));
        }
    };
    let key = verdict.lock().as_ref().map(|(_, key)| format!("{} {}", key_type(key), fingerprint(key))).unwrap_or_default();
    let method = authenticate(&mut session, hop, ssh).await?;
    Ok((session, format!("{} · {method} · clave {key}", hop.label())))
}

/// Logs in with the connection's method; what it used, for «Probar conexión».
async fn authenticate(session: &mut Session, hop: &Hop, ssh: &SshConfig) -> Result<&'static str> {
    let (ok, method) = match ssh.auth.as_str() {
        "agent" => (agent_auth(session, hop).await?, "agente SSH"),
        "key" => {
            let key = load_key(ssh)?;
            let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
            let result = session.authenticate_publickey(hop.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await;
            (result.map_err(|e| anyhow!("SSH: {}: {e}", hop.label()))?.success(), "clave privada")
        }
        _ => {
            let password = ssh
                .password
                .clone()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| anyhow!("SSH: falta la contraseña SSH de {}: escríbela en las propiedades de la conexión, «Túnel SSH».", hop.label()))?;
            let result = session.authenticate_password(hop.user.clone(), password).await;
            (result.map_err(|e| anyhow!("SSH: {}: {e}", hop.label()))?.success(), "contraseña")
        }
    };
    if !ok {
        bail!("SSH: {} no aceptó la autenticación por {method}: revisa el usuario y la {}.", hop.label(), match method {
            "contraseña" => "contraseña SSH",
            "clave privada" => "clave (y que su parte pública esté en authorized_keys)",
            _ => "clave del agente (y que su parte pública esté en authorized_keys)",
        });
    }
    Ok(method)
}

/// `~/…` paths, as OpenSSH writes them.
fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

/// The private key: the file, or the one pasted in the form (kept in the credential store).
pub fn load_key(ssh: &SshConfig) -> Result<keys::PrivateKey> {
    let passphrase = ssh.passphrase.as_deref().filter(|p| !p.is_empty());
    let path = ssh.key_path.trim();
    let text = if path.is_empty() {
        ssh.private_key.clone().filter(|k| !k.trim().is_empty()).ok_or_else(|| anyhow!("SSH: falta la clave privada: elige su fichero o pégala en «Túnel SSH»."))?
    } else {
        std::fs::read_to_string(expand_home(path)).map_err(|e| anyhow!("SSH: no se pudo leer la clave privada {path}: {e}"))?
    };
    keys::decode_secret_key(&text, passphrase).map_err(|e| match e {
        keys::Error::KeyIsEncrypted if passphrase.is_none() => anyhow!("SSH: la clave privada está protegida con una frase de paso: escríbela en «Frase de paso»."),
        keys::Error::KeyIsEncrypted => anyhow!("SSH: la frase de paso de la clave privada no es correcta."),
        other => anyhow!("SSH: no se pudo leer la clave privada ({other}). Celer lee claves OpenSSH, PEM y PuTTY (.ppk); si lleva frase de paso, revisa que sea la correcta."),
    })
}

async fn agent_auth(session: &mut Session, hop: &Hop) -> Result<bool> {
    #[cfg(unix)]
    {
        let mut agent = keys::agent::client::AgentClient::connect_env().await.map_err(|e| anyhow!("SSH: no hay un agente SSH en marcha (SSH_AUTH_SOCK): {e}"))?;
        agent_try(session, hop, &mut agent).await
    }
    #[cfg(windows)]
    {
        // The OpenSSH agent of Windows first, then Pageant.
        if let Ok(mut agent) = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if agent_try(session, hop, &mut agent).await.unwrap_or(false) {
                return Ok(true);
            }
        }
        match keys::agent::client::AgentClient::connect_pageant().await {
            Ok(mut agent) => agent_try(session, hop, &mut agent).await,
            Err(e) => bail!("SSH: no hay un agente SSH en marcha: ni el agente de OpenSSH ni Pageant ({e})."),
        }
    }
}

async fn agent_try<S>(session: &mut Session, hop: &Hop, agent: &mut keys::agent::client::AgentClient<S>) -> Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(|e| anyhow!("SSH: el agente SSH no respondió: {e}"))?;
    if identities.is_empty() {
        bail!("SSH: el agente SSH no tiene ninguna clave cargada (ssh-add, o ábrela en Pageant).");
    }
    let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
    for identity in identities {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else { continue };
        if let Ok(result) = session.authenticate_publickey_with(hop.user.clone(), key, hash, agent).await {
            if result.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

// ───────────────────────────────────────────────────────────────── the tunnel

/// A tunnel up: its SSH sessions (the last one forwards) and the local port the drivers connect to.
pub struct Tunnel {
    pub local_port: u16,
    sessions: Vec<Arc<Session>>,
    target: (String, u16),
    /// Forwarded connections open now.
    active: Arc<AtomicUsize>,
    last_used: Arc<Mutex<Instant>>,
    /// The last forward the SSH server refused (the database server unreachable from it), taken by `explain`.
    error: Arc<Mutex<Option<String>>>,
    accept: tokio::task::JoinHandle<()>,
    /// Every hop with its authentication and host key, for «Probar conexión».
    pub summary: String,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Tunnel {
    /// Every SSH session is still up.
    pub fn alive(&self) -> bool {
        !self.sessions.iter().any(|s| s.is_closed())
    }

    /// The database server as the SSH server reaches it.
    pub fn target_label(&self) -> String {
        host_port(&self.target.0, self.target.1)
    }

    /// A driver could not connect through the tunnel: when the SSH server refused to forward, that is the error.
    pub fn explain(&self, e: anyhow::Error) -> anyhow::Error {
        match self.error.lock().take() {
            Some(forward) => anyhow!("{forward}\n\n({e})"),
            None if !self.alive() => anyhow!("SSH: el túnel SSH se cerró mientras se conectaba a la base de datos ({e})"),
            None => e,
        }
    }

    /// Opens (and closes) one forwarded connection to the database server: the SSH server reaches it.
    pub fn check_forward(&self) -> Result<()> {
        let last = self.sessions.last().cloned().ok_or_else(|| anyhow!("SSH: túnel sin sesión"))?;
        let (host, port) = self.target.clone();
        block(async move {
            let channel = last
                .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| anyhow!("SSH: el servidor SSH no pudo abrir la conexión con {}: {e}", host_port(&host, port)))?;
            let _ = channel.close().await;
            Ok(())
        })
    }
}

/// Copies one forwarded connection both ways. When the database server closes it, the driver sees it closed (FIN),
/// as without a tunnel; when the tunnel itself dropped (the SSH session is gone), the driver sees a reset (RST): a
/// broken link the session guard reconnects and repeats a read on, not a session a DBA killed on purpose.
async fn pipe(mut socket: tokio::net::TcpStream, channel: russh::Channel<client::Msg>, session: &Session) {
    use tokio::io::AsyncWriteExt;
    {
        let (mut from_server, mut to_server) = tokio::io::split(channel.into_stream());
        let (mut from_driver, mut to_driver) = socket.split();
        let up = async {
            let _ = tokio::io::copy(&mut from_driver, &mut to_server).await;
            let _ = to_server.shutdown().await;
        };
        let down = tokio::io::copy(&mut from_server, &mut to_driver);
        tokio::pin!(up, down);
        tokio::select! {
            // The driver is done: the server's last bytes still go through.
            _ = &mut up => { let _ = (&mut down).await; }
            _ = &mut down => {}
        }
    }
    // The SSH session ends a moment after its channels when the bastion goes away.
    for _ in 0..10 {
        if session.is_closed() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if session.is_closed() {
        let _ = socket2::SockRef::from(&socket).set_linger(Some(Duration::ZERO));
    }
}

async fn open_tunnel(plan: Plan) -> Result<Tunnel> {
    let mut sessions: Vec<Arc<Session>> = Vec::new();
    let mut summary = Vec::new();
    for hop in &plan.hops {
        let (session, label) = connect_hop(sessions.last().map(|s| s.as_ref()), hop, &plan.ssh, &plan.known).await?;
        sessions.push(Arc::new(session));
        summary.push(label);
    }
    // The same local port every time for the same connection and server when it is free: Informix over DRDA keeps
    // its "no automatic reconnection" setting per host and port in db2dsdriver.cfg (drivers.rs cli_acr_off), which
    // the IBM CLI reads once, so a port that changed on every tunnel would leave it out.
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", plan.preferred_port())).await {
        Ok(listener) => listener,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| anyhow!("SSH: no se pudo abrir un puerto local para el túnel: {e}"))?,
    };
    let local_port = listener.local_addr()?.port();
    let active = Arc::new(AtomicUsize::new(0));
    let last_used = Arc::new(Mutex::new(Instant::now()));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let last = sessions.last().cloned().ok_or_else(|| anyhow!("SSH: túnel sin servidor SSH"))?;
    let accept = {
        let (active, last_used, error, target) = (active.clone(), last_used.clone(), error.clone(), plan.target.clone());
        let via = plan.hops.last().map(Hop::label).unwrap_or_default();
        tokio::spawn(async move {
            while let Ok((socket, peer)) = listener.accept().await {
                let (session, active, last_used, error, target, via) = (last.clone(), active.clone(), last_used.clone(), error.clone(), target.clone(), via.clone());
                tokio::spawn(async move {
                    let _ = socket.set_nodelay(true);
                    *last_used.lock() = Instant::now();
                    match session.channel_open_direct_tcpip(target.0.clone(), target.1 as u32, peer.ip().to_string(), peer.port() as u32).await {
                        Ok(channel) => {
                            active.fetch_add(1, Ordering::SeqCst);
                            pipe(socket, channel, &session).await;
                            active.fetch_sub(1, Ordering::SeqCst);
                            *last_used.lock() = Instant::now();
                        }
                        Err(e) => {
                            *error.lock() = Some(format!("SSH: {via} no pudo abrir la conexión con {}: {e}. Revisa el servidor y el puerto de la base tal y como los ve el servidor SSH («localhost» es el propio servidor SSH).", host_port(&target.0, target.1)));
                        }
                    }
                });
            }
        })
    };
    Ok(Tunnel { local_port, sessions, target: plan.target, active, last_used, error, accept, summary: summary.join(" → ") })
}

// ───────────────────────────────────────────────────────────────── shared tunnels

fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("celer-ssh")
            .enable_all()
            .build()
            .expect("runtime de los túneles SSH")
    })
}

/// Runs `fut` on the tunnels' runtime and waits for it, from any thread (also from inside another runtime).
fn block<T: Send + 'static>(fut: impl Future<Output = Result<T>> + Send + 'static) -> Result<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    rt().spawn(async move {
        let _ = tx.send(fut.await);
    });
    rx.recv().map_err(|_| anyhow!("SSH: el túnel terminó inesperadamente"))?
}

type Slot = Arc<Mutex<Option<Arc<Tunnel>>>>;

/// The tunnels by `Plan::key`: one per connection and SSH configuration.
fn tunnels() -> &'static Mutex<HashMap<String, Slot>> {
    static TUNNELS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    TUNNELS.get_or_init(Default::default)
}

/// How a connection reaches its server through SSH: built once per connection setup (lib.rs `prepare`), used on
/// every (re)connection.
#[derive(Clone)]
pub struct Plan {
    pub key: String,
    ssh: SshConfig,
    hops: Vec<Hop>,
    target: (String, u16),
    known: Arc<KnownHosts>,
}

impl Plan {
    /// Checks the settings (they fail here, before any connection, when they are incomplete).
    pub fn new(cfg: &ConnConfig, data_dir: &Path) -> Result<Plan> {
        let hops = hops(&cfg.ssh)?;
        let target = target(cfg)?;
        if cfg.ssh.auth == "key" && cfg.ssh.key_path.trim().is_empty() && cfg.ssh.private_key.as_deref().is_none_or(|k| k.trim().is_empty()) {
            bail!("SSH: falta la clave privada: elige su fichero o pégala en «Túnel SSH».");
        }
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_string(&(&cfg.ssh, &target)).unwrap_or_default().as_bytes());
        let key = format!("{}:{}", cfg.id, hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>());
        Ok(Plan { key, ssh: cfg.ssh.clone(), hops, target, known: Arc::new(KnownHosts::new(data_dir)) })
    }

    /// The local port this connection's tunnel asks for first: fixed for a connection and its server, in 20000-29999
    /// (below the systems' ephemeral ports, so a random outgoing connection rarely holds it).
    pub fn preferred_port(&self) -> u16 {
        let owner = self.key.split(':').next().unwrap_or("");
        let mut hasher = Sha256::new();
        hasher.update(format!("{owner}\n{}\n{}", self.target.0, self.target.1).as_bytes());
        let digest = hasher.finalize();
        20000 + (u16::from_be_bytes([digest[0], digest[1]]) % 10000)
    }

    /// "user@bastion:22 → db:5432", for the route of «Probar conexión».
    pub fn label(&self) -> String {
        let hops: Vec<String> = self.hops.iter().map(Hop::label).collect();
        format!("túnel SSH {} → {}", hops.join(" → "), host_port(&self.target.0, self.target.1))
    }

    /// The connection's tunnel: the one up, or a new one when there is none or its SSH session dropped.
    pub fn tunnel(&self) -> Result<Arc<Tunnel>> {
        let slot = tunnels().lock().entry(self.key.clone()).or_default().clone();
        // One at a time per tunnel: sessions opening together share the one the first builds.
        let mut current = slot.lock();
        if let Some(t) = current.as_ref().filter(|t| t.alive()) {
            return Ok(t.clone());
        }
        *current = None;
        let plan = self.clone();
        let tunnel = Arc::new(block(open_tunnel(plan))?);
        *current = Some(tunnel.clone());
        janitor();
        Ok(tunnel)
    }
}

/// Closes the tunnels of a connection with no forwarded connection open (it was disconnected, edited or deleted).
pub fn forget(owner: &str) {
    let prefix = format!("{owner}:");
    let slots: Vec<Slot> = tunnels().lock().iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, s)| s.clone()).collect();
    for slot in slots {
        if let Some(mut current) = slot.try_lock() {
            if current.as_ref().is_some_and(|t| t.active.load(Ordering::SeqCst) == 0) {
                *current = None;
            }
        }
    }
}

/// A thread that closes the tunnels that dropped or that nobody used for `IDLE_CLOSE`.
fn janitor() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new().name("celer-ssh-janitor".into()).spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            let mut map = tunnels().lock();
            map.retain(|_, slot| {
                let Some(mut current) = slot.try_lock() else { return true };
                let idle = current.as_ref().is_some_and(|t| !t.alive() || (t.active.load(Ordering::SeqCst) == 0 && t.last_used.lock().elapsed() > IDLE_CLOSE));
                if idle {
                    *current = None;
                }
                current.is_some()
            });
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test keys made with ssh-keygen (ed25519): KEY_A plain and locked with the passphrase "frase", and B's public key.
    const KEY_A: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAepF3WlYxZUhF2l4MrjQZkfwko+N8DSUftVZe7OTrqBgAAAIhmr112Zq9d
dgAAAAtzc2gtZWQyNTUxOQAAACAepF3WlYxZUhF2l4MrjQZkfwko+N8DSUftVZe7OTrqBg
AAAEBt2f1J70x6xCVk+ahPnPyfcM98vDW4Itwa95h2E/vILh6kXdaVjFlSEXaXgyuNBmR/
CSj43wNJR+1Vl7s5OuoGAAAABHRlc3QB
-----END OPENSSH PRIVATE KEY-----
";
    const KEY_A_LOCKED: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCFN/z2eN
sLmREI3SJV10IeAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIB6kXdaVjFlSEXaX
gyuNBmR/CSj43wNJR+1Vl7s5OuoGAAAAkIQ8RoTKgzX5ok8j3F62zXlbCcqdM9+0qB3dog
zNxPwEW0Cm9GkTdtVmDwMGHPQ5w5sSaUpqRIR38RjS+fp55gJ9RquK8f/FvTzMsNWv0Nn1
oT+7zi7n5b16A2yisQfOaro8B1uWQy6ZmZvlCLI6DQ6tI5st2f4D4NYouIPMGOmCoKXTwY
6t4xTuNyidzz01AQ==
-----END OPENSSH PRIVATE KEY-----
";
    const PUB_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIB6kXdaVjFlSEXaXgyuNBmR/CSj43wNJR+1Vl7s5OuoG";
    const PUB_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIC41+NZJQtVUMQCd674m8Rz7ExbU516UV7jdMruaJXwy";

    #[test]
    fn hops_and_targets() {
        assert_eq!(parse_hop("ana@jump.example.com:2222", "x").unwrap(), Hop { user: "ana".into(), host: "jump.example.com".into(), port: 2222 });
        assert_eq!(parse_hop("jump", "luis").unwrap(), Hop { user: "luis".into(), host: "jump".into(), port: 22 });
        assert_eq!(parse_hop("[2001:db8::1]:2200", "u").unwrap().host, "2001:db8::1");
        assert_eq!(parse_hop("2001:db8::1", "u").unwrap().port, 22);
        assert!(parse_hop("u@host:99999", "u").is_err());
        assert!(parse_hop("@host", "").is_err());
        assert!(parse_hop("", "u").is_err());

        let ssh = SshConfig { enabled: true, host: "bastion".into(), user: "ops".into(), auth: "password".into(), jumps: vec!["edge:2022".into(), "".into(), "root@inner".into()], ..Default::default() };
        let chain = hops(&ssh).unwrap();
        assert_eq!(chain.iter().map(Hop::label).collect::<Vec<_>>(), ["ops@edge:2022", "root@inner:22", "ops@bastion:22"]);
        assert!(hops(&SshConfig { user: "".into(), ..ssh.clone() }).unwrap_err().to_string().contains("usuario"));
        assert!(hops(&SshConfig { host: " ".into(), ..ssh.clone() }).unwrap_err().to_string().contains("servidor"));

        let cfg = |kind: DbKind, host: &str, port: Option<u16>, instance: &str, mode: &str| ConnConfig { kind, host: host.into(), port, instance: instance.into(), informix_mode: mode.into(), ..Default::default() };
        assert_eq!(target(&cfg(DbKind::Postgres, "db.internal", None, "", "")).unwrap(), ("db.internal".into(), 5432));
        assert_eq!(target(&cfg(DbKind::Mysql, "", Some(3307), "", "")).unwrap(), ("localhost".into(), 3307));
        assert_eq!(target(&cfg(DbKind::Informix, "ifx", None, "ol", "drda")).unwrap().1, 9089);
        assert_eq!(target(&cfg(DbKind::Informix, "ifx", None, "ol", "jdbc")).unwrap().1, 9088);
        assert_eq!(target(&cfg(DbKind::Mssql, "sql\\PROD", Some(1500), "", "")).unwrap(), ("sql".into(), 1500));
        assert!(target(&cfg(DbKind::Mssql, "sql", None, "PROD", "")).unwrap_err().to_string().contains("Browser"));
        assert_eq!(target(&cfg(DbKind::Mssql, "[2001:db8::5]", None, "", "")).unwrap(), ("2001:db8::5".into(), 1433));
    }

    #[test]
    fn plans_check_settings_and_never_keep_secrets_in_the_key() {
        let dir = std::env::temp_dir();
        let mut cfg = ConnConfig { id: "c1".into(), kind: DbKind::Postgres, host: "db".into(), ..Default::default() };
        cfg.ssh = SshConfig { enabled: true, host: "bastion".into(), user: "ops".into(), auth: "password".into(), password: Some("s3cret".into()), ..Default::default() };
        let plan = Plan::new(&cfg, &dir).unwrap();
        assert!(plan.key.starts_with("c1:") && !plan.key.contains("s3cret"));
        assert_eq!(plan.label(), "túnel SSH ops@bastion:22 → db:5432");
        // Another password is another tunnel.
        let mut other = cfg.clone();
        other.ssh.password = Some("otra".into());
        assert_ne!(Plan::new(&other, &dir).unwrap().key, plan.key);
        // A key that is neither a file nor pasted.
        // The local port is the same for the connection and its server (whatever the secrets), in 20000-29999.
        let port = plan.preferred_port();
        assert!((20000..30000).contains(&port));
        assert_eq!(Plan::new(&other, &dir).unwrap().preferred_port(), port);
        let elsewhere = ConnConfig { host: "otra".into(), ..cfg.clone() };
        assert_ne!(Plan::new(&elsewhere, &dir).unwrap().preferred_port(), port);
        cfg.ssh.auth = "key".into();
        assert!(Plan::new(&cfg, &dir).err().unwrap().to_string().contains("clave privada"));
        cfg.ssh.private_key = Some("-----BEGIN OPENSSH PRIVATE KEY-----".into());
        assert!(Plan::new(&cfg, &dir).is_ok());
    }

    #[test]
    fn private_keys_are_read_with_their_passphrase() {
        let public = keys::parse_public_key_base64(PUB_A).unwrap();
        let ssh = SshConfig { auth: "key".into(), private_key: Some(KEY_A.into()), ..Default::default() };
        assert_eq!(load_key(&ssh).unwrap().public_key().key_data(), public.key_data());
        let mut ssh = SshConfig { auth: "key".into(), private_key: Some(KEY_A_LOCKED.into()), ..Default::default() };
        assert!(load_key(&ssh).unwrap_err().to_string().contains("frase de paso"));
        ssh.passphrase = Some("mala".into());
        assert!(load_key(&ssh).is_err());
        ssh.passphrase = Some("frase".into());
        assert_eq!(load_key(&ssh).unwrap().public_key().key_data(), public.key_data());
        // From a file.
        let file = std::env::temp_dir().join(format!("celer-ssh-key-{}", std::process::id()));
        std::fs::write(&file, ssh.private_key.as_deref().unwrap()).unwrap();
        let from_file = SshConfig { auth: "key".into(), key_path: file.to_string_lossy().into(), passphrase: Some("frase".into()), ..Default::default() };
        assert_eq!(load_key(&from_file).unwrap().public_key().key_data(), public.key_data());
        let _ = std::fs::remove_file(&file);
        assert!(load_key(&SshConfig { auth: "key".into(), key_path: "/no/existe".into(), ..Default::default() }).unwrap_err().to_string().contains("no se pudo leer"));
    }

    #[test]
    fn known_hosts_check_learn_and_refuse_a_changed_key() {
        let dir = std::env::temp_dir().join(format!("celer-known-hosts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let known = KnownHosts { own: dir.join("known_hosts"), user: Some(dir.join("user_known_hosts")) };
        let a = keys::parse_public_key_base64(PUB_A).unwrap();
        let b = keys::parse_public_key_base64(PUB_B).unwrap();
        // Nothing is accepted before the user trusts it.
        assert_eq!(known.check("bastion", 2222, &a), HostKey::Unknown);
        let hop = Hop { user: "u".into(), host: "bastion".into(), port: 2222 };
        let err = key_error(&hop, &HostKey::Unknown, &a).to_string();
        assert!(err.starts_with("SSH_HOST_UNKNOWN:") && err.contains(&fingerprint(&a)), "{err}");
        let token = err.split(':').nth(1).unwrap().to_string();
        let info = pending_info(&token).unwrap();
        assert_eq!((info.host.as_str(), info.port, info.fingerprint.clone()), ("bastion", 2222, fingerprint(&a)));
        // Trusting writes Celer's file only (the port is part of the entry).
        known.learn("bastion", 2222, &a).unwrap();
        pending().lock().remove(&token);
        assert_eq!(known.check("bastion", 2222, &a), HostKey::Known);
        assert_eq!(known.check("bastion", 22, &a), HostKey::Unknown);
        assert!(std::fs::read_to_string(&known.own).unwrap().contains("[bastion]:2222 ssh-ed25519 "));
        assert!(!dir.join("user_known_hosts").exists());
        // Another key for the same server is refused, with where the old one is.
        let changed = known.check("bastion", 2222, &b);
        assert!(matches!(&changed, HostKey::Changed(at) if at.contains("known_hosts, línea ")), "{changed:?}");
        assert!(key_error(&hop, &changed, &b).to_string().starts_with("SSH_HOST_CHANGED: "));
        // The user's OpenSSH file counts too (read only), also a changed key in it.
        std::fs::write(dir.join("user_known_hosts"), format!("# comentario\nother.host ssh-ed25519 {}\n", b.public_key_base64())).unwrap();
        assert_eq!(known.check("other.host", 22, &b), HostKey::Known);
        assert!(matches!(known.check("other.host", 22, &a), HostKey::Changed(_)));
        // `trust` refuses to replace a kept key.
        let token = remember("bastion", 2222, &b);
        let kept = KnownHosts::new(&dir);
        assert_eq!(kept.own, known.own);
        assert!(trust(&dir, &token).unwrap_err().to_string().contains("otra clave"));
        let token = remember("nuevo", 22, &b);
        assert_eq!(trust(&dir, &token).unwrap().host, "nuevo");
        assert_eq!(known.check("nuevo", 22, &b), HostKey::Known);
        assert!(trust(&dir, &token).is_err(), "only once");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
