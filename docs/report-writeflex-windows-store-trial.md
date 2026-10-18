---
title: WriteFlex Windows Store packaging trial
date: 2026-10-18
status: validation-in-progress
---

# WriteFlex Windows Store packaging trial

This branch builds an unsigned AppX with a deliberately fictitious Store identity. It is a packaging investigation, not a submitted product or a release candidate.

## Sandbox helper repair

The initial Windows run (39106945010) failed during the mandatory postinstall helper build with 23 Rust errors. The bundled helper used Win32 imports, handle types and function signatures incompatible with its declared windows 0.58 dependency.

The repair backports the five MIT-licensed native helper files from owning Bridle commit `f3182b3bf4f6cfc23daf9b491885723f5dc3c54d` (14 October 2026). This includes the matching allocation, handle inheritance, Job Object failure cleanup, ACL rollback and JSON `memoryMB` fixes. It does not update the rest of Bridle or disable the sandbox. Three added request-validation tests cover the actual TypeScript JSON shape and rejection of network access, capabilities and weakened confinement settings. The Windows workflow runs those tests before installing dependencies and building the AppX.

The current owning source at `f931dc3` already contains this fix; no duplicate source change is required. Its Windows cross-target cargo check and 13 Rust unit tests passed locally. The older public snapshot's three new request tests and Windows cross-target cargo check also passed locally. Local tests ran on macOS; the Windows workflow supplies native Windows evidence.

## Shipping blockers

The vendored helper still predates later October confinement hardening in its owning source. Material differences include scratch-only writes with Low integrity labelling, revoking only this run's ACL entries rather than restoring a saved whole DACL, starting the child inside its Job Object, and cancellation cleanup. These must be reconciled with the host wrapper and tested before shipping this sandbox-enabled Windows app. A successful AppX build does not establish that confinement is safe or complete.

Store identity, signing, installed-app testing, Windows App Certification Kit results and human Windows usability review remain separate requirements. Nothing on this branch submits to Microsoft or publishes a release.

## Windows installation dependency layout

After the helper repair, run 39108152839 passed its native helper tests and built the release helper, then failed frozen installation because ten nested relative `file:` peer dependencies could not be copied on Windows. Local vendored peer contracts now name the exact version already installed by the app, instead of asking the installer for another relative file copy. The app now declares those local packages as Bun workspaces, so every package resolves to the checked-in source rather than nested copies. Existing registry dependency versions are retained; the workspace also locks the already-declared lucide-react 1.21.0 development dependency. The lock is regenerated with Bun; postinstall and the native helper build remain mandatory. The matching macOS regression run 39108155442 passed typechecking, unit tests and application build for the helper backport.


Run 39108529050 passed Windows helper tests, frozen installation and application build. Its packaging step exposed PowerShell parsing the dotted `-c.appx.*` arguments as config filenames; the workflow now quotes them individually. The accompanying macOS run 39108532228 passed all checks. Local frozen install, typecheck, 3,465 tests (two existing todos) and application build also passed.


The first successful AppX run (39108794088) passed ZIP integrity and matched the generated SHA-256. Artifact inspection found Rust compiler output bundled through the new workspace links. Packaging now explicitly excludes `native/runner-sandbox/target`, retaining the required `bin/bridle-runner-sandbox.exe`. The successful package was unsigned and used the declared fictitious identity; it was not installed or submitted.
