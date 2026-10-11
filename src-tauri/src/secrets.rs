//! The passwords of an export «con contraseñas» (src/connTree.ts, format celer-connections v2): every secret of the
//! chosen connections (database password, SSH password, key passphrase and pasted key, secret extra parameters),
//! read from the credential store and sealed here, so the plain secrets never reach the interface on export.
//!
//! Sealed with a passphrase: Argon2id (64 MiB, 3 passes) derives an AES-256-GCM key; salt and nonce are random and the
//! file format is the associated data. Without a passphrase («sin cifrar», only after an explicit warning) the
//! secrets go in clear and the file says so.

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::{ssh_account, ConnConfig, SshConfig};

/// Bound to the ciphertext: a v2 secrets block cannot be moved to another format.
const AAD: &[u8] = b"celer-connections v2 secrets";
const MEMORY_KIB: u32 = 64 * 1024;
const PASSES: u32 = 3;
/// What a file may ask the KDF for (a hand-made file must not make Celer allocate gigabytes).
const MAX_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_PASSES: u32 = 16;

/// The prefix of the error for a wrong passphrase (the interface asks again).
pub const WRONG: &str = "SECRETS_PASSPHRASE";

/// The secrets of one connection. Absent: it had none.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SecretSet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_passphrase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key: Option<String>,
    /// Secret entries of "Parámetros extra" / the ODBC string the interface took out of the exported connection, as
    /// it sent them (put back on import).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<Value>,
}

impl SecretSet {
    pub fn is_empty(&self) -> bool {
        *self == SecretSet::default()
    }

    /// The SSH secret of a credential store account (`SshConfig::ACCOUNTS`).
    pub fn ssh_mut(&mut self, account: &str) -> &mut Option<String> {
        match account {
            "ssh-password" => &mut self.ssh_password,
            "ssh-passphrase" => &mut self.ssh_passphrase,
            _ => &mut self.ssh_key,
        }
    }
}

/// The secrets of the connections asked for (`requests`: id and the secret parameters the interface took out, in the
/// file's order), keyed by position: the saved database password (not for Windows authentication) and the SSH secrets
/// the tunnel's method uses, read through `get` (the credential store). A connection without any is left out.
pub fn collect(conns: &[ConnConfig], requests: Vec<(String, Option<Value>)>, get: impl Fn(&str) -> Option<String>) -> BTreeMap<String, SecretSet> {
    let mut sets = BTreeMap::new();
    for (index, (id, inline)) in requests.into_iter().enumerate() {
        let Some(cfg) = conns.iter().find(|c| c.id == id) else { continue };
        let mut set = SecretSet { inline: inline.filter(|v| !v.is_null()), ..Default::default() };
        if cfg.save_password && !cfg.integrated_auth {
            set.password = get(&cfg.id);
        }
        for account in SshConfig::ACCOUNTS.into_iter().filter(|a| cfg.ssh.uses(a)) {
            *set.ssh_mut(account) = get(&ssh_account(&cfg.id, account));
        }
        if !set.is_empty() {
            sets.insert(index.to_string(), set);
        }
    }
    sets
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("No hay números aleatorios del sistema: {e}"))?;
    Ok(bytes)
}

fn derive(passphrase: &str, salt: &[u8], memory: u32, passes: u32, lanes: u32) -> Result<Aes256Gcm> {
    let params = argon2::Params::new(memory, passes, lanes, Some(32)).map_err(|e| anyhow!("Parámetros de Argon2id no válidos: {e}"))?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow!("Argon2id: {e}"))?;
    Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("AES-256-GCM: {e}"))
}

/// The `secrets` block of a v2 file: sealed with `passphrase`, or in clear without one.
pub fn seal(sets: &BTreeMap<String, SecretSet>, passphrase: Option<&str>) -> Result<Value> {
    let plain = serde_json::to_vec(sets)?;
    let Some(passphrase) = passphrase else {
        return Ok(json!({
            "encrypted": false,
            "warning": "Contraseñas SIN CIFRAR: cualquiera que lea este fichero puede usarlas.",
            "data": sets,
        }));
    };
    if passphrase.is_empty() {
        bail!("La contraseña del fichero no puede estar vacía");
    }
    let salt: [u8; 16] = random()?;
    let nonce: [u8; 12] = random()?;
    let cipher = derive(passphrase, &salt, MEMORY_KIB, PASSES, 1)?;
    let data = cipher
        .encrypt(&nonce.into(), Payload { msg: &plain, aad: AAD })
        .map_err(|_| anyhow!("No se pudieron cifrar las contraseñas"))?;
    Ok(json!({
        "encrypted": true,
        "cipher": "AES-256-GCM",
        "kdf": { "name": "Argon2id", "memoryKiB": MEMORY_KIB, "iterations": PASSES, "parallelism": 1, "salt": B64.encode(salt) },
        "nonce": B64.encode(nonce),
        "data": B64.encode(data),
    }))
}

/// The secrets of a v2 `secrets` block. A sealed one needs its passphrase: a wrong one fails with `WRONG` and
/// nothing is returned.
pub fn open(block: &Value, passphrase: Option<&str>) -> Result<BTreeMap<String, SecretSet>> {
    if block.get("encrypted").and_then(Value::as_bool) != Some(true) {
        let data = block.get("data").cloned().unwrap_or(Value::Null);
        return serde_json::from_value(data).map_err(|e| anyhow!("Las contraseñas del fichero no se entienden: {e}"));
    }
    let Some(passphrase) = passphrase.filter(|p| !p.is_empty()) else { bail!("{WRONG}: El fichero tiene las contraseñas cifradas: escribe la contraseña con la que se exportó.") };
    let text = |v: Option<&Value>, what: &str| v.and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow!("Al bloque de contraseñas le falta {what}"));
    let bytes = |v: Option<&Value>, what: &str| B64.decode(text(v, what)?).map_err(|_| anyhow!("{what} no es base64"));
    if block.get("cipher").and_then(Value::as_str) != Some("AES-256-GCM") {
        bail!("Cifrado no admitido: {}", block.get("cipher").unwrap_or(&Value::Null));
    }
    let kdf = block.get("kdf").ok_or_else(|| anyhow!("Al bloque de contraseñas le falta kdf"))?;
    if kdf.get("name").and_then(Value::as_str) != Some("Argon2id") {
        bail!("Derivación de clave no admitida: {}", kdf.get("name").unwrap_or(&Value::Null));
    }
    let num = |key: &str, max: u32| -> Result<u32> {
        let n = kdf.get(key).and_then(Value::as_u64).ok_or_else(|| anyhow!("Al bloque de contraseñas le falta kdf.{key}"))?;
        u32::try_from(n).ok().filter(|n| (1..=max).contains(n)).ok_or_else(|| anyhow!("kdf.{key} fuera de rango ({n})"))
    };
    let (memory, passes, lanes) = (num("memoryKiB", MAX_MEMORY_KIB)?, num("iterations", MAX_PASSES)?, num("parallelism", 16)?);
    let salt = bytes(kdf.get("salt"), "kdf.salt")?;
    let nonce: [u8; 12] = bytes(block.get("nonce"), "nonce")?.try_into().map_err(|_| anyhow!("nonce no tiene 12 bytes"))?;
    let data = bytes(block.get("data"), "data")?;
    let cipher = derive(passphrase, &salt, memory, passes, lanes)?;
    let plain = cipher
        .decrypt(&nonce.into(), Payload { msg: &data, aad: AAD })
        .map_err(|_| anyhow!("{WRONG}: La contraseña no es correcta (o el fichero se ha modificado): no se ha importado ninguna contraseña."))?;
    serde_json::from_slice(&plain).map_err(|e| anyhow!("Las contraseñas del fichero no se entienden: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BTreeMap<String, SecretSet> {
        let mut sets = BTreeMap::new();
        sets.insert("0".into(), SecretSet { password: Some("pg-ñ€".into()), ssh_key: Some("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n".into()), ..Default::default() });
        sets.insert("2".into(), SecretSet { ssh_password: Some("bastion".into()), ssh_passphrase: Some("frase".into()), inline: Some(json!({ "extra": "sslpassword=x" })), ..Default::default() });
        sets
    }

    #[test]
    fn round_trip_and_wrong_passphrase() {
        let sets = sample();
        let block = seal(&sets, Some("correcta caballo pila")).unwrap();
        let text = block.to_string();
        assert_eq!(block["encrypted"], true);
        assert_eq!(block["kdf"]["name"], "Argon2id");
        for secret in ["pg-ñ€", "bastion", "frase", "OPENSSH", "sslpassword"] {
            assert!(!text.contains(secret), "{secret} in clear");
        }
        assert_eq!(open(&block, Some("correcta caballo pila")).unwrap(), sets);
        let wrong = open(&block, Some("otra")).unwrap_err().to_string();
        assert!(wrong.starts_with("SECRETS_PASSPHRASE: "), "{wrong}");
        assert!(open(&block, None).unwrap_err().to_string().starts_with("SECRETS_PASSPHRASE: "));
        // Two exports of the same secrets differ (random salt and nonce).
        assert_ne!(seal(&sets, Some("x")).unwrap()["data"], seal(&sets, Some("x")).unwrap()["data"]);
        // A changed byte is refused like a wrong passphrase.
        let mut tampered = block.clone();
        let mut data = B64.decode(block["data"].as_str().unwrap()).unwrap();
        data[0] ^= 1;
        tampered["data"] = json!(B64.encode(data));
        assert!(open(&tampered, Some("correcta caballo pila")).is_err());
        // A file asking the KDF for too much memory is refused before deriving.
        let mut greedy = block.clone();
        greedy["kdf"]["memoryKiB"] = json!(u32::MAX);
        assert!(open(&greedy, Some("correcta caballo pila")).unwrap_err().to_string().contains("fuera de rango"));
        assert!(seal(&sets, Some("")).is_err());
    }

    #[test]
    fn every_secret_of_the_chosen_connections() {
        use crate::model::DbKind;
        let store: std::collections::HashMap<&str, &str> = [
            ("pg", "pg-pass"),
            ("pg#ssh-password", "never: the tunnel uses a key"),
            ("pg#ssh-passphrase", "frase"),
            ("pg#ssh-key", "KEY"),
            ("win", "ignored"),
            ("odbc", "pwd-from-the-string"),
            ("nosave", "kept anyway"),
        ]
        .into_iter()
        .collect();
        let ssh = SshConfig { enabled: true, host: "b".into(), user: "u".into(), auth: "key".into(), ..Default::default() };
        let conns = vec![
            ConnConfig { id: "pg".into(), kind: DbKind::Postgres, ssh, ..Default::default() },
            ConnConfig { id: "win".into(), kind: DbKind::Mssql, integrated_auth: true, ..Default::default() },
            ConnConfig { id: "odbc".into(), kind: DbKind::Odbc, ..Default::default() },
            ConnConfig { id: "nosave".into(), kind: DbKind::Mysql, save_password: false, ..Default::default() },
        ];
        let requests = vec![
            ("pg".to_string(), Some(json!({ "extra": "sslpassword=x" }))),
            ("win".to_string(), None),
            ("gone".to_string(), None),
            ("odbc".to_string(), Some(Value::Null)),
            ("nosave".to_string(), None),
        ];
        let sets = collect(&conns, requests, |account| store.get(account).map(|s| s.to_string()));
        assert_eq!(sets.keys().collect::<Vec<_>>(), ["0", "3"], "by position; Windows authentication, unknown ids and unsaved passwords give nothing");
        assert_eq!(
            sets["0"],
            SecretSet { password: Some("pg-pass".into()), ssh_password: None, ssh_passphrase: Some("frase".into()), ssh_key: Some("KEY".into()), inline: Some(json!({ "extra": "sslpassword=x" })) }
        );
        assert_eq!(sets["3"].password.as_deref(), Some("pwd-from-the-string"));
        // Round trip through a sealed block.
        assert_eq!(open(&seal(&sets, Some("contraseña larga")).unwrap(), Some("contraseña larga")).unwrap(), sets);
    }

    #[test]
    fn in_clear_only_when_asked() {
        let sets = sample();
        let block = seal(&sets, None).unwrap();
        assert_eq!(block["encrypted"], false);
        assert!(block["warning"].as_str().unwrap().contains("SIN CIFRAR"));
        assert_eq!(open(&block, None).unwrap(), sets);
        assert_eq!(open(&block, Some("ignored")).unwrap(), sets);
    }
}
