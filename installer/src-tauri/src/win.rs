//! Envoltorios mínimos sobre la API de Windows (carpetas conocidas, espacio libre,
//! procesos en ejecución, accesos directos .lnk vía IShellLink).

use std::path::{Path, PathBuf};

use windows::core::{Interface, GUID, HSTRING, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, SHChangeNotify, SHGetKnownFolderPath, ShellLink, KNOWN_FOLDER_FLAG, SHCNE_ASSOCCHANGED,
    SHCNF_IDLIST,
};

pub use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_LocalAppData, FOLDERID_Profile,
    FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_Programs,
    FOLDERID_RoamingAppData, FOLDERID_UserProgramFiles, FOLDERID_Windows,
};

/// Ruta de una carpeta conocida (`FOLDERID_*`).
pub fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s.filter(|s| !s.is_empty()).map(PathBuf::from)
    }
}

/// Bytes libres para el usuario en la unidad de `path` (sube hasta el primer ancestro existente).
pub fn free_bytes(path: &Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            return None;
        }
    }
    let h = HSTRING::from(p.as_os_str());
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&h, Some(&mut free), None, None).ok()? };
    Some(free)
}

/// ¿Hay algún proceso ejecutándose desde exactamente esta ruta de ejecutable?
pub fn is_running(exe: &Path) -> bool {
    let target = crate::setup::path_key(exe);
    let Some(name) = exe.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return false;
    };
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let pname = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                if pname == name {
                    if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID) {
                        let mut buf = [0u16; 2048];
                        let mut n = buf.len() as u32;
                        if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n).is_ok() {
                            let full = String::from_utf16_lossy(&buf[..n as usize]);
                            if crate::setup::path_key(Path::new(&full)) == target {
                                found = true;
                            }
                        }
                        let _ = CloseHandle(h);
                    }
                }
                if found || Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// Inicializa COM (STA) en el hilo actual mientras viva.
pub struct Com(bool);
impl Com {
    pub fn init() -> Self {
        Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// Crea (o sobrescribe) un acceso directo `.lnk`. Requiere COM inicializado en el hilo.
pub fn create_shortcut(lnk: &Path, target: &Path, workdir: &Path, description: &str) -> windows::core::Result<()> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(target.as_os_str()))?;
        link.SetWorkingDirectory(&HSTRING::from(workdir.as_os_str()))?;
        link.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)?;
        link.SetDescription(&HSTRING::from(description))?;
        let file: IPersistFile = link.cast()?;
        file.Save(&HSTRING::from(lnk.as_os_str()), true)?;
    }
    Ok(())
}

/// Destino de un acceso directo `.lnk` (None si no se puede leer). Requiere COM.
pub fn shortcut_target(lnk: &Path) -> Option<PathBuf> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        file.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; 2048];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..len]);
        (!s.is_empty()).then(|| PathBuf::from(s))
    }
}

/// Selector nativo de carpetas (IFileOpenDialog + FOS_PICKFOLDERS). Bloquea hasta que el
/// usuario cierre el diálogo; llamar desde un hilo que no sea el del bucle de eventos.
pub fn pick_folder(owner: Option<isize>, start: Option<&Path>, title: &str) -> Option<PathBuf> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM,
        FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };
    let _com = Com::init();
    unsafe {
        let dlg: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let opts = dlg.GetOptions().ok()?;
        dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST).ok()?;
        let _ = dlg.SetTitle(&HSTRING::from(title));
        if let Some(start) = start {
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start.as_os_str()), None) {
                let _ = dlg.SetFolder(&item);
            }
        }
        let hwnd = owner.map(|h| HWND(h as *mut _));
        dlg.Show(hwnd).ok()?; // cancelar => Err
        let item = dlg.GetResult().ok()?;
        let p = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s.filter(|s| !s.is_empty()).map(PathBuf::from)
    }
}

/// Avisa al Explorador de que cambiaron las asociaciones de archivos.
pub fn notify_assoc_changed() {
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}
