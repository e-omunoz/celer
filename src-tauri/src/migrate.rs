// Migration assistant (docs/DESIGN.md §16): finds the connection files of other database tools so the UI
// can offer to import them. Read-only: nothing is modified in the source tools.
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    /// "dbeaver" | "dbvisualizer"
    pub tool: &'static str,
    /// DBeaver project or DbVisualizer config folder (shown in the UI).
    pub project: String,
    pub path: String,
    pub text: String,
    /// DBeaver's encrypted credentials-config.json next to the data sources, hex-encoded.
    pub credentials_hex: Option<String>,
}

const MAX_FILE: u64 = 8 * 1024 * 1024;

fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// DBeaver workspaces: Windows %APPDATA%, Linux ~/.local/share, macOS ~/Library (DBeaverData/workspace6).
fn dbeaver_workspaces() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(d) = dirs::data_dir() {
        roots.push(d.join("DBeaverData").join("workspace6"));
    }
    if let Some(h) = dirs::home_dir() {
        roots.push(h.join("Library").join("DBeaverData").join("workspace6"));
        roots.push(h.join(".local").join("share").join("DBeaverData").join("workspace6"));
    }
    roots.sort();
    roots.dedup();
    roots.into_iter().filter(|p| p.is_dir()).collect()
}

fn find_dbeaver(out: &mut Vec<SourceFile>) {
    for ws in dbeaver_workspaces() {
        let Ok(projects) = fs::read_dir(&ws) else { continue };
        for project in projects.flatten() {
            let meta = project.path().join(".dbeaver");
            if !meta.is_dir() {
                continue;
            }
            let credentials = fs::read(meta.join("credentials-config.json")).ok().filter(|b| !b.is_empty()).map(|b| hex(&b));
            let Ok(files) = fs::read_dir(&meta) else { continue };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().to_string();
                // data-sources.json plus the extra data-sources-*.json files DBeaver may keep.
                if !(name.starts_with("data-sources") && name.ends_with(".json")) {
                    continue;
                }
                if let Some(text) = read_text(&file.path()) {
                    out.push(SourceFile {
                        tool: "dbeaver",
                        project: project.file_name().to_string_lossy().to_string(),
                        path: file.path().display().to_string(),
                        text,
                        credentials_hex: credentials.clone(),
                    });
                }
            }
        }
    }
}

/// DbVisualizer keeps one folder per major version (~/.dbvis/config70, config230…): newest first.
fn find_dbvisualizer(out: &mut Vec<SourceFile>) {
    let Some(home) = dirs::home_dir() else { return };
    let Ok(entries) = fs::read_dir(home.join(".dbvis")) else { return };
    let mut configs: Vec<(u32, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let n = name.strip_prefix("config")?.parse::<u32>().ok()?;
            Some((n, e.path()))
        })
        .collect();
    configs.sort_by(|a, b| b.0.cmp(&a.0));
    if let Some((_, dir)) = configs.into_iter().find(|(_, d)| d.join("dbvis.xml").is_file()) {
        if let Some(text) = read_text(&dir.join("dbvis.xml")) {
            out.push(SourceFile {
                tool: "dbvisualizer",
                project: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                path: dir.join("dbvis.xml").display().to_string(),
                text,
                credentials_hex: None,
            });
        }
    }
}

pub fn find_sources() -> Vec<SourceFile> {
    let mut out = Vec::new();
    find_dbeaver(&mut out);
    find_dbvisualizer(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encodes() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }

    #[test]
    fn finds_nothing_without_panicking() {
        // On machines without DBeaver/DbVisualizer this simply returns an empty list.
        let _ = find_sources();
    }
}
