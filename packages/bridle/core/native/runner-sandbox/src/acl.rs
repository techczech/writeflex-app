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
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL, PSID};
    use windows::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        SET_ACCESS, SE_FILE_OBJECT, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TRUSTEE_FORM, TRUSTEE_TYPE,
        TRUSTEE_W,
    };
    use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PACL, PSECURITY_DESCRIPTOR};
    use windows::Win32::Storage::FileSystem::{
        FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct OriginalDacl {
        path: String,
        dacl: PACL,
        descriptor: PSECURITY_DESCRIPTOR,
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
            let mut old_dacl = PACL::default();
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
                .map_err(|error| {
                    SetupFailure::new(
                        "filesystem",
                        format!("could not read ACL for {path}: {error}"),
                    )
                })?;

                let mut access = EXPLICIT_ACCESS_W {
                    grfAccessPermissions: mode.permissions(),
                    grfAccessMode: SET_ACCESS,
                    grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                    Trustee: TRUSTEE_W {
                        pMultipleTrustee: null_mut(),
                        MultipleTrusteeOperation: Default::default(),
                        TrusteeForm: TRUSTEE_FORM(0), // TRUSTEE_IS_SID
                        TrusteeType: TRUSTEE_TYPE(0), // TRUSTEE_IS_UNKNOWN
                        ptstrName: sid.0 as *mut u16,
                    },
                };

                let mut new_dacl = PACL::default();
                SetEntriesInAclW(Some(&mut [access]), old_dacl, &mut new_dacl).map_err(
                    |error| {
                        SetupFailure::new(
                            "filesystem",
                            format!("could not build ACL grant for {path}: {error}"),
                        )
                    },
                )?;

                SetNamedSecurityInfoW(
                    PCWSTR(wide.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(new_dacl),
                    None,
                )
                .map_err(|error| {
                    let _ = LocalFree(HLOCAL(new_dacl.0 as isize));
                    SetupFailure::new(
                        "filesystem",
                        format!("could not apply ACL grant for {path}: {error}"),
                    )
                })?;
                let _ = LocalFree(HLOCAL(new_dacl.0 as isize));
            }

            self.originals.push(OriginalDacl {
                path: path.to_string(),
                dacl: old_dacl,
                descriptor,
            });
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
                        None,
                        None,
                        Some(original.dacl),
                        None,
                    );
                    let _ = LocalFree(HLOCAL(original.descriptor.0 as isize));
                }
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
