# Initial local file consent

The app asks once at launch whether bots may read local files. No access is enabled before consent. Allow records the disk root as the read-only file-tool scope; Not now persists the declined request. Existing folder-specific grants remain unchanged, and revocation does not re-trigger onboarding. Settings retains explicit broader consent, folder selection and removal, and links to macOS Full Disk Access settings.

The original folder reader remains limited to listing directories and reading regular UTF-8 text files up to 256 KiB. Absolute paths work only with an explicit disk-root grant. macOS privacy and account permissions remain authoritative; this consent does not itself grant OS Full Disk Access.

Verification: 128 Swift tests passed (28 native, 100 core), including approval persistence, remembered decline, existing scope preservation, revocation and absolute-path boundaries. Existing opt-in adapters remained skipped. Type checking and the action-tool tests passed. The release was rebuilt, signature-verified and installed. The running app was left open; quit and reopen it to load the new permission prompt. No real user file consent was granted by the test suite, which uses isolated UserDefaults suites and reads only its own temporary fixtures.

Apple reference: https://support.apple.com/en-lk/guide/mac-help/mchl211c911f/mac
