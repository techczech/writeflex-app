use crate::SetupFailure;

#[cfg(not(windows))]
pub struct AclRestorer;

#[cfg(not(windows))]
impl AclRestorer {
    pub fn grant_all(
        _sid: (),
        _readable: &[String],
        _writable: &[String],
    ) -> Result<Self, SetupFailure> {
        Err(SetupFailure::new(
            "setup",
            "Windows ACL grants are only available on Windows",
        ))
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::ptr::null_mut;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
        TRUSTEE_W,
    };
    use windows::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    };
    use windows::Win32::Storage::FileSystem::{
        FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Owns a buffer returned by an API that documents LocalFree as its release.
    struct LocalBuffer(*mut core::ffi::c_void);

    impl Drop for LocalBuffer {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = LocalFree(HLOCAL(self.0));
                }
            }
        }
    }

    struct OriginalDacl {
        path: String,
        /// Points into `descriptor`; valid while `descriptor` is alive.
        dacl: *mut ACL,
        _descriptor: LocalBuffer,
    }

    pub struct AclRestorer {
        originals: Vec<OriginalDacl>,
    }

    impl AclRestorer {
        pub fn grant_all(
            sid: PSID,
            readable: &[String],
            writable: &[String],
        ) -> Result<Self, SetupFailure> {
            let mut restorer = Self {
                originals: Vec::new(),
            };
            for path in readable {
                restorer.grant_path(sid, path, AccessMode::ReadExecute)?;
            }
            for path in writable {
                restorer.grant_path(sid, path, AccessMode::ReadWrite)?;
            }
            Ok(restorer)
        }

        fn grant_path(
            &mut self,
            sid: PSID,
            path: &str,
            mode: AccessMode,
        ) -> Result<(), SetupFailure> {
            let wide = to_wide(path);
            let mut old_dacl: *mut ACL = null_mut();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            unsafe {
                GetNamedSecurityInfoW(
                    PCWSTR(wide.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(&mut old_dacl),
                    None,
                    &mut descriptor,
                )
                .to_hresult()
                .ok()
                .map_err(|error| {
                    SetupFailure::new(
                        "filesystem",
                        format!("could not read ACL for {path}: {error}"),
                    )
                })?;
            }
            let descriptor = LocalBuffer(descriptor.0);

            let access = EXPLICIT_ACCESS_W {
                grfAccessPermissions: mode.permissions(),
                grfAccessMode: SET_ACCESS,
                grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    // With TRUSTEE_IS_SID the name field carries the SID pointer.
                    ptstrName: PWSTR(sid.0 as *mut u16),
                },
            };

            let mut new_dacl: *mut ACL = null_mut();
            unsafe {
                SetEntriesInAclW(Some(&[access]), Some(old_dacl), &mut new_dacl)
                    .to_hresult()
                    .ok()
                    .map_err(|error| {
                        SetupFailure::new(
                            "filesystem",
                            format!("could not build ACL grant for {path}: {error}"),
                        )
                    })?;
            }
            let new_dacl = LocalBuffer(new_dacl as *mut core::ffi::c_void);

            // Record the original before applying: SetNamedSecurityInfoW propagates
            // inheritable ACEs down the tree and can fail part-way, so a failed
            // apply must still be rolled back by restore().
            self.originals.push(OriginalDacl {
                path: path.to_string(),
                dacl: old_dacl,
                _descriptor: descriptor,
            });

            unsafe {
                SetNamedSecurityInfoW(
                    PCWSTR(wide.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    PSID::default(),
                    PSID::default(),
                    Some(new_dacl.0 as *const ACL),
                    None,
                )
                .to_hresult()
                .ok()
                .map_err(|error| {
                    SetupFailure::new(
                        "filesystem",
                        format!("could not apply ACL grant for {path}: {error}"),
                    )
                })?;
            }
            Ok(())
        }

        pub fn restore(&mut self) {
            while let Some(original) = self.originals.pop() {
                let wide = to_wide(&original.path);
                unsafe {
                    let _ = SetNamedSecurityInfoW(
                        PCWSTR(wide.as_ptr()),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        PSID::default(),
                        PSID::default(),
                        Some(original.dacl as *const ACL),
                        None,
                    );
                }
                // `original._descriptor` (which owns the memory `dacl` points into)
                // is freed here, after the DACL has been written back.
                drop(original);
            }
        }
    }

    impl Drop for AclRestorer {
        fn drop(&mut self) {
            self.restore();
        }
    }

    enum AccessMode {
        ReadExecute,
        ReadWrite,
    }

    impl AccessMode {
        fn permissions(&self) -> u32 {
            match self {
                Self::ReadExecute => FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0,
                Self::ReadWrite => {
                    FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0 | FILE_GENERIC_WRITE.0
                }
            }
        }
    }

    pub use AclRestorer as WindowsAclRestorer;
}

#[cfg(windows)]
pub use win::WindowsAclRestorer as AclRestorer;
