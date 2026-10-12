//! «Reportar / Sugerir» sent with the user's own GitHub account (#112): the token they paste is kept in the
//! system's credential store only (never in a JSON file, never sent back to the interface), and a report becomes an
//! issue through the REST API. The prefilled github.com page stays as the path that needs no token.
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::store;

const REPO: &str = "e-omunoz/celer";
const ISSUES_URL: &str = "https://api.github.com/repos/e-omunoz/celer/issues";
const TOKEN_ID: &str = "celer-github-report-token";
/// The only labels a report asks for. GitHub drops them, without an error, for an account without triage rights on
/// the repository (the issue is created all the same).
const LABELS: [&str; 3] = ["bug", "enhancement", "status:triage"];
/// GitHub's limit for an issue body.
const MAX_BODY: usize = 65_536;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CreatedIssue {
    pub number: u64,
    pub html_url: String,
}

// ───────────── the token ─────────────

pub fn token_get() -> Option<String> {
    store::keyring_get(TOKEN_ID).filter(|t| !t.trim().is_empty())
}

/// Keeps the token in the credential store; an empty one removes it.
pub fn token_set(token: &str) -> Result<(), String> {
    let token = token.trim();
    if token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("El token no puede tener espacios ni saltos de línea: cópialo de nuevo desde GitHub.".into());
    }
    let entry = keyring::Entry::new(store::keyring_service(), TOKEN_ID).map_err(|e| e.to_string())?;
    store::mark_deleted(TOKEN_ID, token.is_empty());
    if token.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("No se pudo quitar el token del almacén de credenciales: {e}")),
        }
    } else {
        entry.set_password(token).map_err(|e| format!("El almacén de credenciales del sistema no aceptó el token: {e}"))
    }
}

// ───────────── the issue ─────────────

/// The POST that creates the issue: the JSON body (title, body, the allowed labels) and GitHub's headers.
fn build_request(token: &str, title: &str, body: &str, labels: &[String]) -> Result<ureq::http::Request<String>, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("El reporte no tiene título.".into());
    }
    if body.chars().count() > MAX_BODY {
        return Err("El texto es demasiado largo para GitHub (65 536 caracteres como mucho): acórtalo o usa «Abrir en GitHub».".into());
    }
    let labels: Vec<&str> = LABELS.iter().copied().filter(|l| labels.iter().any(|x| x == l)).collect();
    let json = serde_json::json!({ "title": title, "body": body, "labels": labels });
    ureq::http::Request::builder()
        .method("POST")
        .uri(ISSUES_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token.trim()))
        .body(json.to_string())
        // The only way this fails is a header value GitHub would not take either: say so without echoing it.
        .map_err(|_| "El token guardado no es válido: quítalo y pega uno nuevo.".to_string())
}

fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_global(Some(Duration::from_secs(30)))
        // Error statuses come back as responses, so GitHub's own message can be read.
        .http_status_as_error(false)
        .user_agent(format!("Celer/{} (+https://github.com/{REPO})", env!("CARGO_PKG_VERSION")))
        .build();
    ureq::Agent::new_with_config(config)
}

#[derive(Deserialize, Default)]
struct ApiError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

/// What a failed answer means to the user, in Spanish, with what to do next. `body` is GitHub's JSON answer.
fn status_error(code: u16, body: &str) -> String {
    let api: ApiError = serde_json::from_str(body).unwrap_or_default();
    let message = api.message.to_lowercase();
    let fallback = "El borrador sigue guardado; puedes enviarlo con «Abrir en GitHub».";
    match code {
        401 => "GitHub no acepta el token (no es válido, ha caducado o se ha revocado). Crea otro y guárdalo en «Enviar con mi cuenta de GitHub».".into(),
        403 | 429 if code == 429 || message.contains("rate limit") => {
            format!("GitHub ha limitado los envíos por ahora: inténtalo en unos minutos. {fallback}")
        }
        403 => format!(
            "El token no tiene permiso para crear issues en {REPO}: un token clásico necesita el permiso public_repo (los de grano fino solo sirven en repositorios propios). {fallback}"
        ),
        404 => format!("GitHub no encuentra {REPO} con este token: suele faltar el permiso public_repo. {fallback}"),
        410 => format!("Los issues están desactivados en {REPO}. {fallback}"),
        422 => {
            let detail: Vec<String> = api
                .errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()).or_else(|| e.get("field").and_then(|f| f.as_str())).map(str::to_string))
                .collect();
            let why = if detail.is_empty() { api.message.clone() } else { detail.join("; ") };
            let why: String = why.chars().take(200).collect();
            format!("GitHub no ha aceptado el reporte ({}). Revisa el título y el texto. {fallback}", if why.is_empty() { "datos no válidos".into() } else { why })
        }
        500..=599 => format!("GitHub tiene problemas ahora mismo (código {code}): inténtalo más tarde. {fallback}"),
        _ => format!("GitHub respondió con el código {code}. {fallback}"),
    }
}

/// A token is never part of what the user reads, even if some message ever echoed it.
fn without_token(text: String, token: &str) -> String {
    let token = token.trim();
    if token.len() >= 8 { text.replace(token, "…") } else { text }
}

/// Creates the issue with the saved token: its number and address.
pub fn create_issue(title: &str, body: &str, labels: &[String]) -> Result<CreatedIssue, String> {
    let token = token_get().ok_or("No hay un token de GitHub guardado: añádelo en «Enviar con mi cuenta de GitHub» o usa «Abrir en GitHub».")?;
    send(&token, title, body, labels).map_err(|e| without_token(e, &token))
}

fn send(token: &str, title: &str, body: &str, labels: &[String]) -> Result<CreatedIssue, String> {
    let request = build_request(token, title, body, labels)?;
    let mut resp = agent().run(request).map_err(|e| match e {
        ureq::Error::Timeout(_) => "GitHub no ha respondido a tiempo. El borrador sigue guardado; inténtalo de nuevo o usa «Abrir en GitHub».".to_string(),
        other => format!("Sin conexión con GitHub ({other}). El borrador sigue guardado; inténtalo más tarde o usa «Abrir en GitHub»."),
    })?;
    let code = resp.status().as_u16();
    let text = resp.body_mut().with_config().limit(1 << 20).read_to_string().unwrap_or_default();
    if code != 201 {
        return Err(status_error(code, &text));
    }
    let created: CreatedIssue = serde_json::from_str(&text).map_err(|_| "GitHub creó el issue pero su respuesta no se entiende: búscalo en «Mis reportes».".to_string())?;
    // Only a link to this repository's issues goes to «Mis reportes» and to the browser.
    if !created.html_url.starts_with(&format!("https://github.com/{REPO}/issues/")) {
        return Err("GitHub devolvió un enlace inesperado para el issue.".into());
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_request_is_what_github_expects() {
        let req = build_request(" ghp_secret123 ", "  Falla  ", "### Qué\n\nx", &labels(&["bug", "status:triage", "wontfix"])).unwrap();
        assert_eq!(req.method(), "POST");
        assert_eq!(req.uri().to_string(), "https://api.github.com/repos/e-omunoz/celer/issues");
        let h = |name: &str| req.headers().get(name).unwrap().to_str().unwrap().to_string();
        assert_eq!(h("Accept"), "application/vnd.github+json");
        assert_eq!(h("X-GitHub-Api-Version"), "2022-11-28");
        assert_eq!(h("Authorization"), "Bearer ghp_secret123");
        let json: serde_json::Value = serde_json::from_str(req.body()).unwrap();
        assert_eq!(json["title"], "Falla");
        assert_eq!(json["body"], "### Qué\n\nx");
        assert_eq!(json["labels"], serde_json::json!(["bug", "status:triage"]), "only the report labels");
        assert!(!req.body().contains("ghp_secret123"), "the token is only in the header");
    }

    #[test]
    fn bad_input_is_refused_before_sending() {
        assert!(build_request("t", "  ", "x", &[]).unwrap_err().contains("título"));
        assert!(build_request("t", "x", &"a".repeat(MAX_BODY + 1), &[]).unwrap_err().contains("demasiado largo"));
        let e = build_request("ghp_bad\u{7f}token", "x", "y", &[]).unwrap_err();
        assert!(!e.contains("ghp_bad"), "{e}");
    }

    #[test]
    fn errors_say_what_to_do() {
        assert!(status_error(401, r#"{"message":"Bad credentials"}"#).contains("no acepta el token"));
        assert!(status_error(403, r#"{"message":"Resource not accessible by personal access token"}"#).contains("public_repo"));
        assert!(status_error(403, r#"{"message":"API rate limit exceeded for user"}"#).contains("limitado"));
        assert!(status_error(403, r#"{"message":"You have exceeded a secondary rate limit"}"#).contains("limitado"));
        assert!(status_error(429, "").contains("limitado"));
        assert!(status_error(404, r#"{"message":"Not Found"}"#).contains("no encuentra"));
        assert!(status_error(410, r#"{"message":"Issues are disabled for this repo"}"#).contains("desactivados"));
        let e = status_error(422, r#"{"message":"Validation Failed","errors":[{"resource":"Issue","code":"custom","field":"body","message":"body is too long"}]}"#);
        assert!(e.contains("body is too long"), "{e}");
        assert!(status_error(422, "not json").contains("datos no válidos"));
        assert!(status_error(502, "<html>").contains("código 502"));
        for code in [401, 403, 404, 410, 422, 500, 418] {
            let e = status_error(code, "{}");
            assert!(code == 401 || e.contains("Abrir en GitHub"), "{code}: the browser path is offered: {e}");
        }
    }

    #[test]
    fn the_token_never_reaches_a_message() {
        assert_eq!(without_token("x ghp_abcdefgh123 y".into(), "ghp_abcdefgh123"), "x … y");
        assert!(token_set("two words").unwrap_err().contains("espacios"));
    }

    /// Live: `CELER_GITHUB_REPORT_TEST=$(gh auth token) cargo test --lib report::tests::live -- --nocapture` creates
    /// one issue in the real repository (closed by hand right after). Never run by CI.
    #[test]
    fn live_creates_one_issue() {
        let Ok(token) = std::env::var("CELER_GITHUB_REPORT_TEST") else { return };
        let body = "### What happened? · Qué ha pasado\n\nPrueba automática del envío por API de «Reportar / Sugerir» (#112). Se cierra en cuanto se crea.";
        let created = send(&token, "[prueba de Celer] envío por API — se cierra solo", body, &labels(&["bug", "status:triage"])).map_err(|e| without_token(e, &token)).unwrap();
        assert!(created.number > 0);
        println!("issue creado: #{} {}", created.number, created.html_url);
    }
}
