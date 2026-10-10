//! Acceso ODBC/CLI con carga dinámica de la librería (sin enlazar en compilación).
//! Permite usar el gestor ODBC del sistema (odbc32.dll) o cargar directamente un driver
//! CLI, como el IBM Data Server Driver (db2cli64.dll) para Informix vía DRDA.

use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::{Arc, LazyLock};

use anyhow::{anyhow, bail, Result};
use libloading::Library;
use parking_lot::Mutex;

use crate::model::*;

pub type H = *mut c_void;

pub const SQL_HANDLE_ENV: i16 = 1;
pub const SQL_HANDLE_DBC: i16 = 2;
pub const SQL_HANDLE_STMT: i16 = 3;
const SQL_SUCCESS: i16 = 0;
const SQL_SUCCESS_WITH_INFO: i16 = 1;
const SQL_NO_DATA: i16 = 100;
const SQL_ERROR: i16 = -1;
const SQL_INVALID_HANDLE: i16 = -2;
const SQL_NTS: i16 = -3;
const SQL_NULL_DATA: isize = -1;
/// Prefilled into the indicator arrays before a block fetch; no driver writes it (see `fetch_block`).
const IND_SENTINEL: isize = 0x5A5A_5A5A_5A5A_5A5A;
const SQL_NO_TOTAL: isize = -4;
const SQL_ATTR_ODBC_VERSION: i32 = 200;
const SQL_ATTR_AUTOCOMMIT: i32 = 102;
const SQL_ATTR_LOGIN_TIMEOUT: i32 = 103;
const SQL_ATTR_CURRENT_CATALOG: i32 = 109;
const SQL_ATTR_ROW_ARRAY_SIZE: i32 = 27;
const SQL_ATTR_ROWS_FETCHED_PTR: i32 = 26;
const SQL_ATTR_ROW_BIND_TYPE: i32 = 5;
const SQL_CLOSE: u16 = 0;
const SQL_UNBIND: u16 = 2;
const SQL_DESC_TYPE_NAME: u16 = 14;
const SQL_C_WCHAR: i16 = -8;
const SQL_C_SBIGINT: i16 = -25;
const SQL_C_DOUBLE: i16 = 8;
const SQL_C_BIT: i16 = -7;
const SQL_C_BINARY: i16 = -2;
pub const SQL_DBMS_NAME: u16 = 17;
pub const SQL_DBMS_VER: u16 = 18;
pub const SQL_DATABASE_NAME: u16 = 16;
pub const SQL_IDENTIFIER_QUOTE_CHAR: u16 = 29;
const SQL_FETCH_NEXT: u16 = 1;
const SQL_FETCH_FIRST: u16 = 2;

const LOB_LIMIT_CHARS: usize = 1_000_000;
pub(crate) const BINARY_PREVIEW: usize = 4096;
const BLOCK_BYTES: usize = 4 * 1024 * 1024;

type FnAllocHandle = unsafe extern "system" fn(i16, H, *mut H) -> i16;
type FnFreeHandle = unsafe extern "system" fn(i16, H) -> i16;
type FnSetAttr = unsafe extern "system" fn(H, i32, *mut c_void, i32) -> i16;
type FnDriverConnect =
    unsafe extern "system" fn(H, *mut c_void, *const u16, i16, *mut u16, i16, *mut i16, u16) -> i16;
type FnH = unsafe extern "system" fn(H) -> i16;
type FnExecDirect = unsafe extern "system" fn(H, *const u16, i32) -> i16;
type FnNumResultCols = unsafe extern "system" fn(H, *mut i16) -> i16;
type FnDescribeCol = unsafe extern "system" fn(
    H,
    u16,
    *mut u16,
    i16,
    *mut i16,
    *mut i16,
    *mut usize,
    *mut i16,
    *mut i16,
) -> i16;
type FnColAttribute =
    unsafe extern "system" fn(H, u16, u16, *mut c_void, i16, *mut i16, *mut isize) -> i16;
type FnGetData = unsafe extern "system" fn(H, u16, i16, *mut c_void, isize, *mut isize) -> i16;
type FnBindCol = unsafe extern "system" fn(H, u16, i16, *mut c_void, isize, *mut isize) -> i16;
type FnRowCount = unsafe extern "system" fn(H, *mut isize) -> i16;
type FnGetDiagRec =
    unsafe extern "system" fn(i16, H, i16, *mut u16, *mut i32, *mut u16, i16, *mut i16) -> i16;
type FnEndTran = unsafe extern "system" fn(i16, H, i16) -> i16;
type FnFreeStmt = unsafe extern "system" fn(H, u16) -> i16;
type FnCatalog4 = unsafe extern "system" fn(
    H,
    *const u16,
    i16,
    *const u16,
    i16,
    *const u16,
    i16,
    *const u16,
    i16,
) -> i16;
type FnCatalog3 =
    unsafe extern "system" fn(H, *const u16, i16, *const u16, i16, *const u16, i16) -> i16;
type FnGetInfo = unsafe extern "system" fn(H, u16, *mut c_void, i16, *mut i16) -> i16;
type FnEnum =
    unsafe extern "system" fn(H, u16, *mut u16, i16, *mut i16, *mut u16, i16, *mut i16) -> i16;

pub struct Api {
    _lib: Library,
    alloc_handle: FnAllocHandle,
    free_handle: FnFreeHandle,
    set_env_attr: FnSetAttr,
    set_connect_attr: FnSetAttr,
    set_stmt_attr: FnSetAttr,
    driver_connect: FnDriverConnect,
    disconnect: FnH,
    exec_direct: FnExecDirect,
    num_result_cols: FnNumResultCols,
    describe_col: FnDescribeCol,
    col_attribute: FnColAttribute,
    fetch: FnH,
    get_data: FnGetData,
    bind_col: FnBindCol,
    more_results: FnH,
    row_count: FnRowCount,
    get_diag_rec: FnGetDiagRec,
    cancel: FnH,
    end_tran: FnEndTran,
    free_stmt: FnFreeStmt,
    tables: FnCatalog4,
    columns: FnCatalog4,
    primary_keys: FnCatalog3,
    get_info: FnGetInfo,
    drivers: Option<FnEnum>,
    data_sources: Option<FnEnum>,
    /// SQLLEN is 32 bits: IBM's CLI driver loaded directly (built without ODBC64) writes 4-byte lengths and
    /// indicators where the ODBC headers of a 64-bit system say 8, on Windows (db2cli64.dll) as on Linux and macOS.
    /// A driver manager (odbc32.dll, unixODBC) and the other drivers use 8.
    len32: bool,
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

/// IBM Data Server Driver (CLI) library: libdb2.so / libdb2.dylib (db2cli64.dll on Windows).
fn is_ibm_cli(path: &str) -> bool {
    // The file name after either separator: a Windows path is recognised on every system (and in the unit test).
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default().to_lowercase();
    name.starts_with("libdb2") || name.starts_with("db2cli") || name.starts_with("libdb2o")
}

static APIS: LazyLock<Mutex<HashMap<String, Arc<Api>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

impl Api {
    /// Carga (una sola vez por ruta) la librería ODBC/CLI indicada.
    pub fn load(path: &str) -> Result<Arc<Api>> {
        let mut map = APIS.lock();
        if let Some(a) = map.get(path) {
            return Ok(a.clone());
        }
        let api = Arc::new(unsafe { Api::load_inner(path)? });
        map.insert(path.to_string(), api.clone());
        Ok(api)
    }

    unsafe fn load_inner(path: &str) -> Result<Api> {
        #[cfg(windows)]
        let lib: Library = {
            // Permite que el driver encuentre sus DLL dependientes en su propia carpeta.
            const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x8;
            let p = std::path::Path::new(path);
            let l = if p.is_absolute() {
                libloading::os::windows::Library::load_with_flags(p, LOAD_WITH_ALTERED_SEARCH_PATH)
            } else {
                libloading::os::windows::Library::new(p)
            };
            l.map_err(|e| anyhow!("No se pudo cargar {path}: {e}"))?
                .into()
        };
        #[cfg(not(windows))]
        let lib = Library::new(path).map_err(|e| anyhow!("No se pudo cargar {path}: {e}"))?;

        macro_rules! sym {
            ($name:literal) => {
                *lib.get(concat!($name, "\0").as_bytes())
                    .map_err(|e| anyhow!("{} no exporta {}: {}", path, $name, e))?
            };
        }
        macro_rules! opt {
            ($name:literal) => {
                lib.get(concat!($name, "\0").as_bytes()).ok().map(|s| *s)
            };
        }
        Ok(Api {
            alloc_handle: sym!("SQLAllocHandle"),
            free_handle: sym!("SQLFreeHandle"),
            set_env_attr: sym!("SQLSetEnvAttr"),
            set_connect_attr: sym!("SQLSetConnectAttrW"),
            set_stmt_attr: sym!("SQLSetStmtAttrW"),
            driver_connect: sym!("SQLDriverConnectW"),
            disconnect: sym!("SQLDisconnect"),
            exec_direct: sym!("SQLExecDirectW"),
            num_result_cols: sym!("SQLNumResultCols"),
            describe_col: sym!("SQLDescribeColW"),
            col_attribute: sym!("SQLColAttributeW"),
            fetch: sym!("SQLFetch"),
            get_data: sym!("SQLGetData"),
            bind_col: sym!("SQLBindCol"),
            more_results: sym!("SQLMoreResults"),
            row_count: sym!("SQLRowCount"),
            get_diag_rec: sym!("SQLGetDiagRecW"),
            cancel: sym!("SQLCancel"),
            end_tran: sym!("SQLEndTran"),
            free_stmt: sym!("SQLFreeStmt"),
            tables: sym!("SQLTablesW"),
            columns: sym!("SQLColumnsW"),
            primary_keys: sym!("SQLPrimaryKeysW"),
            get_info: sym!("SQLGetInfoW"),
            drivers: opt!("SQLDriversW"),
            data_sources: opt!("SQLDataSourcesW"),
            _lib: lib,
            len32: is_ibm_cli(path),
        })
    }

    /// A length or indicator as the driver wrote it: with a 32-bit SQLLEN only the low 4 bytes are its own (the
    /// variable was zeroed before the call), and -1 / -4 arrive as 0xFFFFFFFF / 0xFFFFFFFC there. Reading the low 4
    /// bytes is also right for a 64-bit driver (every length fits, -1 / -4 keep their sign), so IBM's CLI driver is
    /// always read this way, on Windows too: its Windows build was seen padding names with NULs like the Linux one.
    fn len(&self, raw: isize) -> isize {
        if self.len32 {
            raw as i32 as isize
        } else {
            raw
        }
    }

    /// Mensajes de diagnóstico de un handle.
    pub fn diag(&self, kind: i16, h: H) -> String {
        let mut msgs = Vec::new();
        for rec in 1..=10i16 {
            let mut state = [0u16; 6];
            let mut native = 0i32;
            let mut msg = vec![0u16; 2048];
            let mut len = 0i16;
            let rc = unsafe {
                (self.get_diag_rec)(
                    kind,
                    h,
                    rec,
                    state.as_mut_ptr(),
                    &mut native,
                    msg.as_mut_ptr(),
                    msg.len() as i16,
                    &mut len,
                )
            };
            if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                break;
            }
            let st = String::from_utf16_lossy(&state[..5]);
            let text = String::from_utf16_lossy(&msg[..(len.max(0) as usize).min(msg.len())]);
            msgs.push(format!("[{st}] {}", text.trim()));
        }
        if msgs.is_empty() {
            "Error ODBC sin diagnóstico".into()
        } else {
            msgs.join("\n")
        }
    }

    fn check(&self, rc: i16, kind: i16, h: H) -> Result<()> {
        match rc {
            SQL_SUCCESS | SQL_SUCCESS_WITH_INFO | SQL_NO_DATA => Ok(()),
            SQL_INVALID_HANDLE => bail!("Handle ODBC no válido"),
            _ => bail!(self.diag(kind, h)),
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Entorno + conexión ODBC.
pub struct OdbcConn {
    pub api: Arc<Api>,
    env: H,
    pub dbc: H,
    /// The statement running now, for the session's canceller (kept when the driver reconnects).
    pub cancel_slot: Arc<Mutex<usize>>,
}

unsafe impl Send for OdbcConn {}

impl OdbcConn {
    pub fn connect(api: Arc<Api>, conn_str: &str, timeout_secs: u32) -> Result<OdbcConn> {
        unsafe {
            let mut env: H = null_mut();
            let rc = (api.alloc_handle)(SQL_HANDLE_ENV, null_mut(), &mut env);
            if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                bail!("No se pudo crear el entorno ODBC");
            }
            (api.set_env_attr)(env, SQL_ATTR_ODBC_VERSION, 3usize as *mut c_void, 0);
            let mut dbc: H = null_mut();
            let rc = (api.alloc_handle)(SQL_HANDLE_DBC, env, &mut dbc);
            if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                let e = api.diag(SQL_HANDLE_ENV, env);
                (api.free_handle)(SQL_HANDLE_ENV, env);
                bail!(e);
            }
            (api.set_connect_attr)(
                dbc,
                SQL_ATTR_LOGIN_TIMEOUT,
                timeout_secs as usize as *mut c_void,
                0,
            );
            let cs = wide(conn_str);
            let mut out = vec![0u16; 2048];
            let mut out_len = 0i16;
            let rc = (api.driver_connect)(
                dbc,
                null_mut(),
                cs.as_ptr(),
                SQL_NTS,
                out.as_mut_ptr(),
                out.len() as i16,
                &mut out_len,
                0,
            );
            if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                let e = api.diag(SQL_HANDLE_DBC, dbc);
                (api.free_handle)(SQL_HANDLE_DBC, dbc);
                (api.free_handle)(SQL_HANDLE_ENV, env);
                bail!(e);
            }
            Ok(OdbcConn { api, env, dbc, cancel_slot: Arc::new(Mutex::new(0)) })
        }
    }

    pub fn set_autocommit(&self, on: bool) -> Result<()> {
        let rc = unsafe {
            (self.api.set_connect_attr)(
                self.dbc,
                SQL_ATTR_AUTOCOMMIT,
                (on as usize) as *mut c_void,
                0,
            )
        };
        self.api.check(rc, SQL_HANDLE_DBC, self.dbc)
    }

    pub fn end_tran(&self, commit: bool) -> Result<()> {
        let rc =
            unsafe { (self.api.end_tran)(SQL_HANDLE_DBC, self.dbc, if commit { 0 } else { 1 }) };
        self.api.check(rc, SQL_HANDLE_DBC, self.dbc)
    }

    pub fn set_catalog(&self, name: &str) -> Result<()> {
        let w = wide(name);
        let rc = unsafe {
            (self.api.set_connect_attr)(
                self.dbc,
                SQL_ATTR_CURRENT_CATALOG,
                w.as_ptr() as *mut c_void,
                ((w.len() - 1) * 2) as i32,
            )
        };
        self.api.check(rc, SQL_HANDLE_DBC, self.dbc)
    }

    pub fn info(&self, what: u16) -> String {
        let mut buf = vec![0u16; 512];
        let mut len = 0i16;
        let rc = unsafe {
            (self.api.get_info)(
                self.dbc,
                what,
                buf.as_mut_ptr() as *mut c_void,
                (buf.len() * 2) as i16,
                &mut len,
            )
        };
        if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..(len.max(0) as usize / 2).min(buf.len())])
    }

    pub fn alloc_stmt(&self) -> Result<Stmt> {
        let mut h: H = null_mut();
        let rc = unsafe { (self.api.alloc_handle)(SQL_HANDLE_STMT, self.dbc, &mut h) };
        self.api.check(rc, SQL_HANDLE_DBC, self.dbc)?;
        Ok(Stmt::new(self.api.clone(), h))
    }

    /// Ejecuta y devuelve todas las filas del primer resultado (para metadatos).
    pub fn query_all(&self, sql: &str) -> Result<Vec<Vec<Cell>>> {
        let mut st = self.alloc_stmt()?;
        st.exec(sql)?;
        st.collect_all()
    }

    pub fn catalog_tables(
        &self,
        catalog: Option<&str>,
        schema: Option<&str>,
        table: Option<&str>,
        types: Option<&str>,
    ) -> Result<Vec<Vec<Cell>>> {
        let mut st = self.alloc_stmt()?;
        let a = [catalog, schema, table, types].map(|s| s.map(wide));
        let p = |w: &Option<Vec<u16>>| w.as_ref().map(|v| v.as_ptr()).unwrap_or(null());
        let l = |w: &Option<Vec<u16>>| if w.is_some() { SQL_NTS } else { 0 };
        let rc = unsafe {
            (self.api.tables)(
                st.h,
                p(&a[0]),
                l(&a[0]),
                p(&a[1]),
                l(&a[1]),
                p(&a[2]),
                l(&a[2]),
                p(&a[3]),
                l(&a[3]),
            )
        };
        self.api.check(rc, SQL_HANDLE_STMT, st.h)?;
        st.collect_all()
    }

    pub fn catalog_columns(
        &self,
        catalog: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<Vec<Cell>>> {
        let mut st = self.alloc_stmt()?;
        let a = [catalog, schema, table].map(|s| if s.is_empty() { None } else { Some(wide(s)) });
        let p = |w: &Option<Vec<u16>>| w.as_ref().map(|v| v.as_ptr()).unwrap_or(null());
        let l = |w: &Option<Vec<u16>>| if w.is_some() { SQL_NTS } else { 0 };
        let rc = unsafe {
            (self.api.columns)(
                st.h,
                p(&a[0]),
                l(&a[0]),
                p(&a[1]),
                l(&a[1]),
                p(&a[2]),
                l(&a[2]),
                null(),
                0,
            )
        };
        self.api.check(rc, SQL_HANDLE_STMT, st.h)?;
        st.collect_all()
    }

    pub fn catalog_pks(&self, catalog: &str, schema: &str, table: &str) -> Result<Vec<Vec<Cell>>> {
        let mut st = self.alloc_stmt()?;
        let a = [catalog, schema, table].map(|s| if s.is_empty() { None } else { Some(wide(s)) });
        let p = |w: &Option<Vec<u16>>| w.as_ref().map(|v| v.as_ptr()).unwrap_or(null());
        let l = |w: &Option<Vec<u16>>| if w.is_some() { SQL_NTS } else { 0 };
        let rc = unsafe {
            (self.api.primary_keys)(
                st.h,
                p(&a[0]),
                l(&a[0]),
                p(&a[1]),
                l(&a[1]),
                p(&a[2]),
                l(&a[2]),
            )
        };
        self.api.check(rc, SQL_HANDLE_STMT, st.h)?;
        st.collect_all()
    }
}

impl Drop for OdbcConn {
    fn drop(&mut self) {
        unsafe {
            (self.api.disconnect)(self.dbc);
            (self.api.free_handle)(SQL_HANDLE_DBC, self.dbc);
            (self.api.free_handle)(SQL_HANDLE_ENV, self.env);
        }
    }
}

#[derive(Clone)]
struct ColPlan {
    ctype: i16,
    elem: usize,
    lob: bool,
    /// Timestamps and times: the column's fractional digits (the text is cut to them; DRDA sends six).
    frac: Option<u8>,
}

/// "2024-03-15 10:20:30.123450" with `digits` fractional digits ("…30.12345"; none: "…30").
pub(crate) fn fit_fraction(s: String, digits: u8) -> String {
    let Some(dot) = s.rfind('.') else { return s };
    // Only a time's fraction (hh:mm:ss.ffff), not a date or an offset.
    if dot < 8 || !s[..dot].ends_with(|c: char| c.is_ascii_digit()) || s[dot - 3..dot].chars().nth(0) != Some(':') {
        return s;
    }
    let end = s[dot + 1..].find(|c: char| !c.is_ascii_digit()).map_or(s.len(), |i| dot + 1 + i);
    let keep = (digits as usize).min(end - dot - 1);
    let cut = if keep == 0 { dot } else { dot + 1 + keep };
    format!("{}{}", &s[..cut], &s[end..])
}

struct Bound {
    bufs: Vec<Vec<u8>>,
    inds: Vec<Vec<isize>>,
    fetched: Box<usize>,
}

/// Sentencia ODBC con lectura por bloques (column-wise binding) cuando es posible.
pub struct Stmt {
    api: Arc<Api>,
    pub h: H,
    plans: Vec<ColPlan>,
    pub columns: Vec<ColumnInfo>,
    bound: Option<Bound>,
    buffer: VecDeque<Vec<Cell>>,
    finished: bool,
    pub in_result: bool,
    pub messages: Vec<String>,
    /// Ranura compartida con el cancelador de la sesión.
    cancel_slot: Option<Arc<Mutex<usize>>>,
}

unsafe impl Send for Stmt {}

impl Stmt {
    fn new(api: Arc<Api>, h: H) -> Stmt {
        Stmt {
            api,
            h,
            plans: vec![],
            columns: vec![],
            bound: None,
            buffer: VecDeque::new(),
            finished: true,
            in_result: false,
            messages: vec![],
            cancel_slot: None,
        }
    }

    pub fn register_cancel(&mut self, slot: Arc<Mutex<usize>>) {
        *slot.lock() = self.h as usize;
        self.cancel_slot = Some(slot);
    }

    pub fn exec(&mut self, sql: &str) -> Result<()> {
        let w = wide(sql);
        let rc = unsafe { (self.api.exec_direct)(self.h, w.as_ptr(), (w.len() - 1) as i32) };
        match rc {
            SQL_SUCCESS | SQL_NO_DATA => Ok(()),
            SQL_SUCCESS_WITH_INFO => {
                self.messages.push(self.api.diag(SQL_HANDLE_STMT, self.h));
                Ok(())
            }
            _ => bail!(self.api.diag(SQL_HANDLE_STMT, self.h)),
        }
    }

    pub fn num_cols(&self) -> Result<usize> {
        let mut n = 0i16;
        let rc = unsafe { (self.api.num_result_cols)(self.h, &mut n) };
        self.api.check(rc, SQL_HANDLE_STMT, self.h)?;
        Ok(n.max(0) as usize)
    }

    pub fn row_count(&self) -> i64 {
        let mut n: isize = 0;
        let rc = unsafe { (self.api.row_count)(self.h, &mut n) };
        if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
            return -1;
        }
        self.api.len(n) as i64
    }

    /// Avanza al siguiente resultado del lote. Devuelve false si no hay más.
    pub fn more_results(&mut self) -> Result<bool> {
        self.unbind();
        let rc = unsafe { (self.api.more_results)(self.h) };
        match rc {
            SQL_NO_DATA => Ok(false),
            SQL_SUCCESS => Ok(true),
            SQL_SUCCESS_WITH_INFO => {
                self.messages.push(self.api.diag(SQL_HANDLE_STMT, self.h));
                Ok(true)
            }
            _ => bail!(self.api.diag(SQL_HANDLE_STMT, self.h)),
        }
    }

    fn unbind(&mut self) {
        if self.bound.take().is_some() {
            unsafe {
                (self.api.free_stmt)(self.h, SQL_UNBIND);
                let one: usize = 1;
                (self.api.set_stmt_attr)(self.h, SQL_ATTR_ROW_ARRAY_SIZE, one as *mut c_void, 0);
                (self.api.set_stmt_attr)(self.h, SQL_ATTR_ROWS_FETCHED_PTR, null_mut(), 0);
            }
        }
        self.buffer.clear();
        self.in_result = false;
        self.finished = true;
    }

    /// Describe el resultado actual y prepara la lectura.
    pub fn begin_result(&mut self, ncols: usize) -> Result<()> {
        self.unbind();
        self.columns.clear();
        self.plans.clear();
        for c in 1..=ncols as u16 {
            let mut name = vec![0u16; 512];
            let (mut name_len, mut dtype, mut dec, mut nullable) = (0i16, 0i16, 0i16, 0i16);
            let mut size: usize = 0;
            let rc = unsafe {
                (self.api.describe_col)(
                    self.h,
                    c,
                    name.as_mut_ptr(),
                    name.len() as i16,
                    &mut name_len,
                    &mut dtype,
                    &mut size,
                    &mut dec,
                    &mut nullable,
                )
            };
            self.api.check(rc, SQL_HANDLE_STMT, self.h)?;
            let col_name =
                String::from_utf16_lossy(&name[..(name_len.max(0) as usize).min(name.len())]);
            let mut tbuf = vec![0u16; 128];
            let mut tlen = 0i16;
            let mut num: isize = 0;
            unsafe {
                (self.api.col_attribute)(
                    self.h,
                    c,
                    SQL_DESC_TYPE_NAME,
                    tbuf.as_mut_ptr() as *mut c_void,
                    (tbuf.len() * 2) as i16,
                    &mut tlen,
                    &mut num,
                )
            };
            let mut type_name =
                String::from_utf16_lossy(&tbuf[..(tlen.max(0) as usize / 2).min(tbuf.len())])
                    .to_lowercase();
            let (mut plan, kind) = plan_for(dtype, size);
            if matches!(dtype, 93 | 11 | 92 | 10) {
                plan.frac = Some(dec.clamp(0, 9) as u8);
            }
            if type_name.is_empty() {
                type_name = sql_type_name(dtype).into();
            }
            self.columns.push(ColumnInfo {
                name: col_name,
                type_name,
                kind,
            });
            self.plans.push(plan);
        }
        self.finished = false;
        self.in_result = true;
        if !self.plans.iter().any(|p| p.lob) && !self.plans.is_empty() {
            self.bind_block()?;
        }
        Ok(())
    }

    fn bind_block(&mut self) -> Result<()> {
        let row_bytes: usize = self.plans.iter().map(|p| p.elem + 8).sum::<usize>().max(1);
        let rows = (BLOCK_BYTES / row_bytes).clamp(1, 512);
        let mut b = Bound {
            bufs: vec![],
            inds: vec![],
            fetched: Box::new(0),
        };
        unsafe {
            (self.api.set_stmt_attr)(self.h, SQL_ATTR_ROW_BIND_TYPE, null_mut(), 0);
            let rc =
                (self.api.set_stmt_attr)(self.h, SQL_ATTR_ROW_ARRAY_SIZE, rows as *mut c_void, 0);
            if rc != SQL_SUCCESS {
                // El driver no admite lectura por bloques: se lee fila a fila.
                return Ok(());
            }
            (self.api.set_stmt_attr)(
                self.h,
                SQL_ATTR_ROWS_FETCHED_PTR,
                (&mut *b.fetched) as *mut usize as *mut c_void,
                0,
            );
        }
        for (i, p) in self.plans.iter().enumerate() {
            let mut buf = vec![0u8; p.elem * rows];
            let mut ind = vec![0isize; rows];
            let rc = unsafe {
                (self.api.bind_col)(
                    self.h,
                    (i + 1) as u16,
                    p.ctype,
                    buf.as_mut_ptr() as *mut c_void,
                    p.elem as isize,
                    ind.as_mut_ptr(),
                )
            };
            self.api.check(rc, SQL_HANDLE_STMT, self.h)?;
            b.bufs.push(buf);
            b.inds.push(ind);
        }
        self.bound = Some(b);
        Ok(())
    }

    fn fetch_block(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        if let Some(b) = &mut self.bound {
            for ind in &mut b.inds {
                ind.fill(IND_SENTINEL);
            }
        }
        let rc = unsafe { (self.api.fetch)(self.h) };
        match rc {
            SQL_NO_DATA => {
                self.finished = true;
                return Ok(());
            }
            SQL_SUCCESS | SQL_SUCCESS_WITH_INFO => {}
            _ => {
                self.finished = true;
                bail!(self.api.diag(SQL_HANDLE_STMT, self.h));
            }
        }
        if let Some(b) = &self.bound {
            // Never more than the arrays hold, whatever the driver wrote (the unsafe read below relies on it).
            let n = (*b.fetched).min(b.inds.first().map_or(0, |i| i.len()));
            // An indicator array is filled 4 bytes per row by a driver with a 32-bit SQLLEN (IBM's CLI) and 8 by the
            // others, whatever the platform: from two rows on, the last slot is still the sentinel when the entries
            // were narrow. With one row the slot is only half overwritten: its high 4 bytes still hold the sentinel's.
            let narrow = (self.api.len32 && !cfg!(windows))
                || (n >= 2 && b.inds.iter().any(|i| i[n - 1] == IND_SENTINEL))
                || (n == 1
                    && b.inds.iter().any(|i| (i[0] as u64) >> 32 == (IND_SENTINEL as u64) >> 32));
            for r in 0..n {
                let mut row = Vec::with_capacity(self.plans.len());
                for (c, p) in self.plans.iter().enumerate() {
                    // A 32-bit SQLLEN driver fills the indicator array 4 bytes per row.
                    let ind = if narrow {
                        // SAFETY: the array holds `rows` isize values, room for `rows` i32 ones; r < fetched <= rows.
                        unsafe { *(b.inds[c].as_ptr() as *const i32).add(r) as isize }
                    } else {
                        b.inds[c][r]
                    };
                    let data = &b.bufs[c][r * p.elem..(r + 1) * p.elem];
                    row.push(decode(p, data, ind));
                }
                self.buffer.push_back(row);
            }
            if n == 0 {
                self.finished = true;
            }
        } else {
            let mut row = Vec::with_capacity(self.plans.len());
            for c in 0..self.plans.len() {
                row.push(self.get_data(c)?);
            }
            self.buffer.push_back(row);
        }
        Ok(())
    }

    fn get_data(&self, c: usize) -> Result<Cell> {
        let p = &self.plans[c];
        let col = (c + 1) as u16;
        unsafe {
            match p.ctype {
                SQL_C_WCHAR => {
                    let mut out: Vec<u16> = Vec::new();
                    let mut chunk = vec![0u16; 8192];
                    loop {
                        let mut ind: isize = 0;
                        let rc = (self.api.get_data)(
                            self.h,
                            col,
                            SQL_C_WCHAR,
                            chunk.as_mut_ptr() as *mut c_void,
                            (chunk.len() * 2) as isize,
                            &mut ind,
                        );
                        if rc == SQL_NO_DATA {
                            break;
                        }
                        if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                            bail!(self.api.diag(SQL_HANDLE_STMT, self.h));
                        }
                        let ind = self.api.len(ind);
                        if ind == SQL_NULL_DATA {
                            return Ok(Cell::Null);
                        }
                        let avail = chunk.len() - 1;
                        let n = if ind == SQL_NO_TOTAL || ind as usize / 2 > avail {
                            avail
                        } else {
                            ind as usize / 2
                        };
                        out.extend_from_slice(&chunk[..n]);
                        if rc == SQL_SUCCESS {
                            break;
                        }
                        if out.len() >= LOB_LIMIT_CHARS {
                            let mut s = String::from_utf16_lossy(&out);
                            s.push('…');
                            return Ok(Cell::Text(s));
                        }
                    }
                    let s = String::from_utf16_lossy(&out);
                    Ok(Cell::Text(match p.frac {
                        Some(digits) => fit_fraction(s, digits),
                        None => s,
                    }))
                }
                SQL_C_BINARY => {
                    let mut buf = vec![0u8; BINARY_PREVIEW + 1];
                    let mut ind: isize = 0;
                    let rc = (self.api.get_data)(
                        self.h,
                        col,
                        SQL_C_BINARY,
                        buf.as_mut_ptr() as *mut c_void,
                        buf.len() as isize,
                        &mut ind,
                    );
                    if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO && rc != SQL_NO_DATA {
                        bail!(self.api.diag(SQL_HANDLE_STMT, self.h));
                    }
                    let ind = self.api.len(ind);
                    if ind == SQL_NULL_DATA {
                        return Ok(Cell::Null);
                    }
                    let n = if ind == SQL_NO_TOTAL || ind as usize > buf.len() {
                        buf.len()
                    } else {
                        ind as usize
                    };
                    Ok(Cell::hex(&buf[..n], BINARY_PREVIEW))
                }
                _ => {
                    let mut buf = [0u8; 8];
                    let mut ind: isize = 0;
                    let rc = (self.api.get_data)(
                        self.h,
                        col,
                        p.ctype,
                        buf.as_mut_ptr() as *mut c_void,
                        8,
                        &mut ind,
                    );
                    if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                        bail!(self.api.diag(SQL_HANDLE_STMT, self.h));
                    }
                    Ok(decode(p, &buf[..p.elem], self.api.len(ind)))
                }
            }
        }
    }

    /// Lee hasta `n` filas del resultado actual. Devuelve (filas, hay_más).
    pub fn read(&mut self, n: usize) -> Result<(Vec<Vec<Cell>>, bool)> {
        let mut rows = Vec::with_capacity(n.min(4096));
        while rows.len() < n {
            if let Some(r) = self.buffer.pop_front() {
                rows.push(r);
                continue;
            }
            if self.finished {
                break;
            }
            self.fetch_block()?;
        }
        if self.buffer.is_empty() && !self.finished {
            self.fetch_block()?;
        }
        let more = !self.buffer.is_empty();
        if !more {
            self.in_result = false;
        }
        Ok((rows, more))
    }

    /// Todas las filas del primer resultado.
    pub fn collect_all(&mut self) -> Result<Vec<Vec<Cell>>> {
        let n = self.num_cols()?;
        if n == 0 {
            return Ok(vec![]);
        }
        self.begin_result(n)?;
        let (rows, _) = self.read(usize::MAX)?;
        Ok(rows)
    }
}

impl Drop for Stmt {
    fn drop(&mut self) {
        let guard = self.cancel_slot.as_ref().map(|s| s.lock());
        unsafe {
            (self.api.free_stmt)(self.h, SQL_CLOSE);
            (self.api.free_handle)(SQL_HANDLE_STMT, self.h);
        }
        if let Some(mut g) = guard {
            *g = 0;
        }
    }
}

pub fn cancel_stmt(api: &Api, slot: &Mutex<usize>) {
    let g = slot.lock();
    if *g != 0 {
        unsafe { (api.cancel)(*g as H) };
    }
}

fn plan_for(dtype: i16, size: usize) -> (ColPlan, ColKind) {
    let wchar = |chars: usize| ColPlan {
        ctype: SQL_C_WCHAR,
        elem: (chars + 1) * 2,
        lob: false,
        frac: None,
    };
    let wlob = ColPlan {
        ctype: SQL_C_WCHAR,
        elem: 0,
        lob: true,
        frac: None,
    };
    match dtype {
        -7 => (
            ColPlan {
                ctype: SQL_C_BIT,
                elem: 1,
                lob: false,
                frac: None,
            },
            ColKind::Bool,
        ),
        -6 | 5 | 4 | -5 => (
            ColPlan {
                ctype: SQL_C_SBIGINT,
                elem: 8,
                lob: false,
                frac: None,
            },
            ColKind::Number,
        ),
        6 | 7 | 8 => (
            ColPlan {
                ctype: SQL_C_DOUBLE,
                elem: 8,
                lob: false,
                frac: None,
            },
            ColKind::Number,
        ),
        2 | 3 => (wchar(size.clamp(1, 100) + 3), ColKind::Number),
        -2 | -3 if size > 0 && size <= 8000 => (
            ColPlan {
                ctype: SQL_C_BINARY,
                elem: size,
                lob: false,
                frac: None,
            },
            ColKind::Binary,
        ),
        -2 | -3 | -4 => (
            ColPlan {
                ctype: SQL_C_BINARY,
                elem: 0,
                lob: true,
                frac: None,
            },
            ColKind::Binary,
        ),
        -1 | -10 => (wlob, ColKind::Text),
        9 | 10 | 11 | 91 | 92 | 93 => (wchar(size.clamp(1, 60) + 4), ColKind::Date),
        -11 => (wchar(40), ColKind::Other),
        1 | 12 | -8 | -9 => {
            if size == 0 || size > 8000 {
                (wlob, ColKind::Text)
            } else {
                (wchar(size), ColKind::Text)
            }
        }
        _ => {
            if size == 0 || size > 8000 {
                (wlob, ColKind::Other)
            } else {
                (wchar(size.max(32)), ColKind::Other)
            }
        }
    }
}

fn sql_type_name(t: i16) -> &'static str {
    match t {
        -7 => "bit",
        -6 => "tinyint",
        5 => "smallint",
        4 => "integer",
        -5 => "bigint",
        6 => "float",
        7 => "real",
        8 => "double",
        2 => "numeric",
        3 => "decimal",
        1 => "char",
        12 => "varchar",
        -1 => "longvarchar",
        -8 => "nchar",
        -9 => "nvarchar",
        -10 => "nlongvarchar",
        91 | 9 => "date",
        92 | 10 => "time",
        93 | 11 => "timestamp",
        -2 => "binary",
        -3 => "varbinary",
        -4 => "longvarbinary",
        -11 => "guid",
        _ => "desconocido",
    }
}

fn decode(p: &ColPlan, data: &[u8], ind: isize) -> Cell {
    if ind == SQL_NULL_DATA {
        return Cell::Null;
    }
    match p.ctype {
        SQL_C_SBIGINT => Cell::int(i64::from_le_bytes(data[..8].try_into().unwrap())),
        SQL_C_DOUBLE => Cell::num(f64::from_le_bytes(data[..8].try_into().unwrap())),
        SQL_C_BIT => Cell::Bool(data[0] != 0),
        SQL_C_BINARY => {
            let n = if ind == SQL_NO_TOTAL || ind as usize > data.len() {
                data.len()
            } else {
                ind as usize
            };
            Cell::hex(&data[..n], BINARY_PREVIEW)
        }
        _ => {
            let cap = data.len() / 2 - 1;
            let (n, trunc) = if ind == SQL_NO_TOTAL || ind as usize / 2 > cap {
                (cap, true)
            } else {
                (ind as usize / 2, false)
            };
            let u: Vec<u16> = data[..n * 2]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let mut s = String::from_utf16_lossy(&u);
            if let Some(digits) = p.frac {
                s = fit_fraction(s, digits);
            }
            if trunc {
                s.push('…');
            }
            Cell::Text(s)
        }
    }
}

/// Drivers ODBC instalados en el sistema (requiere el gestor ODBC).
pub fn list_drivers() -> Result<Vec<String>> {
    let api = Api::load(system_manager())?;
    let f = api
        .drivers
        .ok_or_else(|| anyhow!("El gestor ODBC no permite listar drivers"))?;
    enumerate(&api, f)
}

/// DSN configurados en el sistema.
pub fn list_dsns() -> Result<Vec<String>> {
    let api = Api::load(system_manager())?;
    let f = api
        .data_sources
        .ok_or_else(|| anyhow!("El gestor ODBC no permite listar DSN"))?;
    enumerate(&api, f)
}

fn enumerate(api: &Api, f: FnEnum) -> Result<Vec<String>> {
    let mut out = Vec::new();
    unsafe {
        let mut env: H = null_mut();
        (api.alloc_handle)(SQL_HANDLE_ENV, null_mut(), &mut env);
        (api.set_env_attr)(env, SQL_ATTR_ODBC_VERSION, 3usize as *mut c_void, 0);
        let mut dir = SQL_FETCH_FIRST;
        loop {
            let mut a = vec![0u16; 512];
            let mut b = vec![0u16; 2048];
            let (mut la, mut lb) = (0i16, 0i16);
            let rc = f(
                env,
                dir,
                a.as_mut_ptr(),
                a.len() as i16,
                &mut la,
                b.as_mut_ptr(),
                b.len() as i16,
                &mut lb,
            );
            if rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO {
                break;
            }
            out.push(String::from_utf16_lossy(
                &a[..(la.max(0) as usize).min(a.len())],
            ));
            dir = SQL_FETCH_NEXT;
        }
        (api.free_handle)(SQL_HANDLE_ENV, env);
    }
    Ok(out)
}

/// The Informix Client SDK's ODBC driver, as Celer's SQLI connection string names it.
pub const IFX_ODBC_DRIVER: &str = "IBM INFORMIX ODBC DRIVER (64-bit)";

/// Informix ODBC drivers registered in the system (the Client SDK's), best match first.
pub fn informix_odbc_drivers() -> Vec<String> {
    let mut found: Vec<String> = list_drivers().unwrap_or_default().into_iter().filter(|d| d.to_lowercase().contains("informix")).collect();
    found.sort_by_key(|d| !d.eq_ignore_ascii_case(IFX_ODBC_DRIVER));
    found
}

pub fn system_manager() -> &'static str {
    if cfg!(windows) {
        "odbc32.dll"
    } else if cfg!(target_os = "macos") {
        "libiodbc.2.dylib"
    } else {
        "libodbc.so.2"
    }
}

#[allow(dead_code)]
const _: i16 = SQL_ERROR;

#[cfg(test)]
mod tests {
    use super::{fit_fraction, is_ibm_cli};

    #[test]
    fn fractions_fit_the_column() {
        let f = |s: &str, d| fit_fraction(s.to_string(), d);
        assert_eq!(f("2024-03-15 10:20:30.123450", 5), "2024-03-15 10:20:30.12345");
        assert_eq!(f("2024-03-15 10:20:30.000000", 0), "2024-03-15 10:20:30");
        assert_eq!(f("08:30:00.500000", 1), "08:30:00.5");
        assert_eq!(f("2024-03-15 10:20:30.1", 3), "2024-03-15 10:20:30.1", "never adds digits");
        assert_eq!(f("2024-03-15", 0), "2024-03-15");
        assert_eq!(f("2024-03-15 10:20:30.123 +02:00", 0), "2024-03-15 10:20:30 +02:00");
    }

    #[test]
    fn ibm_cli_library_names() {
        assert!(is_ibm_cli("/opt/clidriver/lib/libdb2.so"));
        assert!(is_ibm_cli("/x/libdb2.dylib"));
        assert!(is_ibm_cli(r"C:\IBM\clidriver\bin\db2cli64.dll"));
        assert!(!is_ibm_cli("/usr/lib/x86_64-linux-gnu/libodbc.so.2"));
    }
}
