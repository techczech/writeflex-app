//! Filesystem grants for the per-run AppContainer SID (Windows only).
//!
//! The helper changes host security descriptors in exactly two ways:
//! - readable roots: add one inheritable read+execute ACE for its own per-run
//!   AppContainer SID, and later revoke ACEs for that SID only (never writing
//!   back a saved DACL, so a concurrent helper's ACE is never clobbered);
//! - the host-created scratch root: a Low mandatory label plus one inheritable
//!   read/write/delete ACE. The host deletes scratch, so it needs no rollback.
//!
//! Object identity is always an open handle, never a pathname. Each path is
//! opened once; every later check and security change goes through that
//! handle, so replacing or renaming a path after it was opened cannot redirect
//! a change to another object.
//!
//! - Scratch: opened without following a final reparse point, before
//!   containment is checked. Its label and ACE are written with
//!   `SetKernelObjectSecurity`, which changes only the object behind the
//!   handle and propagates nothing to existing children (the propagating
//!   `Set[Named]SecurityInfo` would re-open children by name). Children the
//!   child process creates later inherit both at creation.
//! - Read roots: existing descendants must inherit the read ACE, so these use
//!   `SetSecurityInfo` on the open handle, which propagates inheritable ACEs to
//!   existing descendants. The root is the handle's object; descendants are
//!   reached by name during propagation (see the README residuals). The same
//!   handle is held for the run and used for the revoke.
//!
//! Every read-modify-write of a DACL runs under a session-wide named mutex so
//! overlapping helpers in one Windows session do not lose each other's edits.
//! Nothing here undoes work in `Drop`: the caller must call
//! [`AclGrants::revoke`] and handle its result.

use crate::SetupFailure;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::ptr::null_mut;
use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, HANDLE, HLOCAL, WAIT_ABANDONED, WAIT_OBJECT_0, WIN32_ERROR,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, ACCESS_MODE,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT,
    TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    AddMandatoryAce, GetLengthSid, InitializeAcl, InitializeSecurityDescriptor,
    SetKernelObjectSecurity, SetSecurityDescriptorDacl, SetSecurityDescriptorSacl, ACE_FLAGS, ACL,
    ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, LABEL_SECURITY_INFORMATION,
    NO_INHERITANCE, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GETFINALPATHNAMEBYHANDLE_FLAGS,
    READ_CONTROL, VOLUME_NAME_DOS, WRITE_DAC, WRITE_OWNER,
};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject, INFINITE};

/// SYSTEM_MANDATORY_LABEL_NO_WRITE_UP (winnt.h). Defined here because the
/// windows crate places it in `Win32_System_SystemServices`, which this crate
/// does not enable (same pattern as SE_GROUP_INTEGRITY in confine.rs).
const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP: u32 = 0x1;
/// SECURITY_DESCRIPTOR_REVISION (winnt.h), also in `Win32_System_SystemServices`.
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

/// Owns a buffer returned by an API that documents LocalFree as its release.
struct LocalBuffer(*mut c_void);

impl Drop for LocalBuffer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = LocalFree(HLOCAL(self.0));
            }
        }
    }
}

/// Holds the session-wide ACL mutex. Release cannot fail while we own the
/// mutex, and if the helper dies holding it Windows marks it abandoned and
/// the next waiter still acquires it.
struct AclLock(HANDLE);

impl AclLock {
    fn acquire() -> Result<Self, String> {
        let handle = unsafe { CreateMutexW(None, false, w!("Local\\Bridle.RunnerSandbox.Acl")) }
            .map_err(|error| format!("could not open the ACL mutex: {error}"))?;
        let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(Self(handle))
        } else {
            let error = windows::core::Error::from_win32();
            unsafe {
                let _ = CloseHandle(handle);
            }
            Err(format!("could not acquire the ACL mutex: {error}"))
        }
    }
}

impl Drop for AclLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

fn win32(result: WIN32_ERROR, what: &str, path: &str) -> Result<(), String> {
    result
        .to_hresult()
        .ok()
        .map_err(|error| format!("could not {what} for {path}: {error}"))
}

fn raw(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}

/// Open `path` as a file or directory with exactly `access`. std applies its
/// long-path handling; the handle, not the name, is the object from here on.
fn open_object(path: &str, access: u32, share: u32, flags: u32) -> Result<File, String> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(share)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | flags)
        .open(path)
        .map_err(|error| format!("could not open {path}: {error}"))
}

/// The normalised `\\?\` DOS path of an open handle (the form
/// `std::fs::canonicalize` returns).
fn final_path(file: &File, path: &str) -> Result<String, String> {
    let mut buffer = vec![0u16; 512];
    loop {
        let len = unsafe {
            // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS (both 0); the flag type
            // has no BitOr.
            GetFinalPathNameByHandleW(
                raw(file),
                &mut buffer,
                GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0),
            )
        } as usize;
        if len == 0 {
            return Err(format!(
                "could not read the final path of {path}: {}",
                windows::core::Error::from_win32()
            ));
        }
        if len < buffer.len() {
            return String::from_utf16(&buffer[..len])
                .map_err(|_| format!("final path of {path} is not valid Unicode"));
        }
        // `len` is the required size including the terminator.
        buffer.resize(len + 1, 0);
    }
}

fn explicit_access(sid: PSID, mode: ACCESS_MODE, permissions: u32, inherit: ACE_FLAGS) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: permissions,
        grfAccessMode: mode,
        grfInheritance: inherit,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            // With TRUSTEE_IS_SID the name field carries the SID pointer.
            ptstrName: PWSTR(sid.0 as *mut u16),
        },
    }
}

/// Read the DACL of the open object and merge `entry` into it
/// (SetEntriesInAclW only touches ACEs for the entry's trustee). A NULL DACL
/// grants everyone full access; merging one ACE into it would leave a DACL
/// holding only that ACE, so it is refused before anything is written.
fn merged_dacl(file: &File, entry: EXPLICIT_ACCESS_W, path: &str) -> Result<LocalBuffer, String> {
    let mut old_dacl: *mut ACL = null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    win32(
        unsafe {
            GetSecurityInfo(
                raw(file),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old_dacl),
                None,
                Some(&mut descriptor),
            )
        },
        "read the ACL",
        path,
    )?;
    // old_dacl points into this descriptor; keep it alive until merged.
    let _descriptor = LocalBuffer(descriptor.0);
    if old_dacl.is_null() {
        return Err(format!(
            "{path} has a NULL DACL; refusing to modify its security descriptor"
        ));
    }
    let mut new_dacl: *mut ACL = null_mut();
    win32(
        unsafe { SetEntriesInAclW(Some(&[entry]), Some(old_dacl as *const ACL), &mut new_dacl) },
        "build the ACL entry",
        path,
    )?;
    Ok(LocalBuffer(new_dacl as *mut c_void))
}

/// Write `dacl` to the open object with SetSecurityInfo, which also
/// propagates inheritable ACEs to existing descendants.
fn set_dacl_propagating(file: &File, dacl: &LocalBuffer, path: &str) -> Result<(), String> {
    win32(
        unsafe {
            SetSecurityInfo(
                raw(file),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                PSID::default(),
                PSID::default(),
                Some(dacl.0 as *const ACL),
                None,
            )
        },
        "apply the ACL entry",
        path,
    )
}

/// The host-created scratch root, opened once before containment is checked.
/// The handle is its identity until [`AclGrants::label_scratch`] consumes it.
pub struct ScratchRoot {
    file: File,
    path: String,
}

impl ScratchRoot {
    /// Open `requested` without following a final reparse point, refuse a
    /// reparse point or a non-directory, and take the handle's own final path
    /// as the scratch path for every containment check. Sharing excludes
    /// delete, so the directory cannot be renamed while the handle is open and
    /// that path stays the object's path through labelling.
    pub fn open(requested: &str) -> Result<Self, SetupFailure> {
        Self::open_inner(requested).map_err(|detail| SetupFailure::new("filesystem", detail))
    }

    fn open_inner(requested: &str) -> Result<Self, String> {
        let file = open_object(
            requested,
            READ_CONTROL.0 | WRITE_DAC.0 | WRITE_OWNER.0 | FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0,
            FILE_FLAG_OPEN_REPARSE_POINT.0,
        )?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(raw(&file), &mut info) }
            .map_err(|error| format!("could not query {requested}: {error}"))?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(format!("scratchRoot is a reparse point: {requested}"));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err(format!("scratchRoot is not a directory: {requested}"));
        }
        let path = final_path(&file, requested)?;
        Ok(Self { file, path })
    }

    /// The canonical extended path of the open directory, for containment.
    pub fn path(&self) -> &str {
        &self.path
    }
}

/// A read root and the handle its ACE was written through.
struct ReadRoot {
    file: File,
    path: String,
}

/// Read ACEs this run added for its own AppContainer SID. The SID is owned by
/// the AppContainer profile, which must outlive this value.
pub struct AclGrants {
    sid: PSID,
    read_roots: Vec<ReadRoot>,
}

impl AclGrants {
    /// Grant read+execute on each readable root, through a handle held until
    /// [`AclGrants::revoke`].
    pub fn grant_reads(sid: PSID, readable: &[String]) -> Result<Self, SetupFailure> {
        let mut grants = Self {
            sid,
            read_roots: Vec::new(),
        };
        for path in readable {
            if let Err(detail) = grants.grant_read(path) {
                let detail = match grants.revoke() {
                    Ok(()) => detail,
                    Err(revoke) => format!("{detail}; {}", revoke.detail),
                };
                return Err(SetupFailure::new("filesystem", detail));
            }
        }
        Ok(grants)
    }

    fn grant_read(&mut self, path: &str) -> Result<(), String> {
        // Follows links (a runtime home may be one); the grant lands on the
        // object the handle reaches. Sharing allows rename and delete: the
        // handle, not the name, is what the revoke uses.
        let file = open_object(
            path,
            READ_CONTROL.0 | WRITE_DAC.0 | FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0,
            0,
        )?;
        let _lock = AclLock::acquire()?;
        let entry = explicit_access(
            self.sid,
            GRANT_ACCESS,
            FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        );
        let dacl = merged_dacl(&file, entry, path)?;
        // Record before the Set call: a partially propagated grant still
        // needs revoking.
        self.read_roots.push(ReadRoot {
            file,
            path: path.to_string(),
        });
        let root = self.read_roots.last().expect("just pushed");
        set_dacl_propagating(&root.file, &dacl, path)
    }

    /// Label the scratch root Low (object and container inherit,
    /// no-write-up) and grant the AppContainer SID read, write, execute and
    /// delete on it, in one `SetKernelObjectSecurity` call on the handle
    /// opened by [`ScratchRoot::open`]. That call changes only the object
    /// behind the handle and pushes nothing down to existing children, so no
    /// other object can receive the label or ACE. Children created later by
    /// the confined process inherit both. No rollback: the host deletes the
    /// scratch tree after the run.
    pub fn label_scratch(sid: PSID, scratch: ScratchRoot) -> Result<(), SetupFailure> {
        Self::label_scratch_inner(sid, &scratch)
            .map_err(|detail| SetupFailure::new("filesystem", detail))
    }

    fn label_scratch_inner(sid: PSID, scratch: &ScratchRoot) -> Result<(), String> {
        let path = scratch.path();
        let _lock = AclLock::acquire()?;
        let entry = explicit_access(
            sid,
            GRANT_ACCESS,
            FILE_GENERIC_READ.0
                | FILE_GENERIC_WRITE.0
                | FILE_GENERIC_EXECUTE.0
                | DELETE.0
                | FILE_DELETE_CHILD.0,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        );
        // Refuses a NULL DACL before anything is written.
        let dacl = merged_dacl(&scratch.file, entry, path)?;

        let mut low_sid = PSID::default();
        unsafe { ConvertStringSidToSidW(w!("S-1-16-4096"), &mut low_sid) }
            .map_err(|error| format!("could not create low-integrity SID: {error}"))?;
        // ConvertStringSidToSidW documents LocalFree.
        let _low_sid_owner = LocalBuffer(low_sid.0);
        // ACL header + SYSTEM_MANDATORY_LABEL_ACE (header, mask, SID) with room
        // to spare; u32 elements keep the ACL DWORD-aligned.
        let size = 64 + unsafe { GetLengthSid(low_sid) } as usize;
        let mut sacl_buffer = vec![0u32; size.div_ceil(4)];
        let sacl = sacl_buffer.as_mut_ptr() as *mut ACL;
        // An absolute descriptor whose DACL and SACL point at the buffers
        // above; all of them outlive the SetKernelObjectSecurity call.
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let psd = PSECURITY_DESCRIPTOR(&mut descriptor as *mut SECURITY_DESCRIPTOR as *mut c_void);
        unsafe {
            InitializeAcl(sacl, (sacl_buffer.len() * 4) as u32, ACL_REVISION)
                .map_err(|error| format!("could not initialise label ACL: {error}"))?;
            AddMandatoryAce(
                sacl,
                ACL_REVISION,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
                low_sid,
            )
            .map_err(|error| format!("could not build Low label: {error}"))?;
            InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION)
                .map_err(|error| format!("could not initialise security descriptor: {error}"))?;
            SetSecurityDescriptorDacl(psd, true, Some(dacl.0 as *const ACL), false)
                .map_err(|error| format!("could not attach the scratch DACL: {error}"))?;
            SetSecurityDescriptorSacl(psd, true, Some(sacl as *const ACL), false)
                .map_err(|error| format!("could not attach the Low label: {error}"))?;
            SetKernelObjectSecurity(
                raw(&scratch.file),
                DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
                psd,
            )
            .map_err(|error| {
                format!("could not set the Low label and scratch ACL entry for {path}: {error}")
            })
        }
    }

    /// Remove every ACE for this run's SID from the read roots it touched,
    /// newest first, through the handle each grant was written through.
    /// Attempts every root; reports all failures together.
    pub fn revoke(&mut self) -> Result<(), SetupFailure> {
        let mut failures = Vec::new();
        while let Some(root) = self.read_roots.pop() {
            if let Err(detail) = self.revoke_one(&root) {
                failures.push(detail);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(SetupFailure::new(
                "filesystem",
                format!("could not revoke read grants: {}", failures.join("; ")),
            ))
        }
    }

    fn revoke_one(&self, root: &ReadRoot) -> Result<(), String> {
        let _lock = AclLock::acquire()?;
        let entry = explicit_access(self.sid, REVOKE_ACCESS, 0, NO_INHERITANCE);
        let dacl = merged_dacl(&root.file, entry, &root.path)?;
        set_dacl_propagating(&root.file, &dacl, &root.path)
    }
}
