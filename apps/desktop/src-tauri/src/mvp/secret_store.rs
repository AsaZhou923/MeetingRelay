use std::fmt;

#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};

const MAX_SECRET_ID_LEN: usize = 192;
const MAX_SECRET_BYTES: usize = 2_560;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type SecretStoreResult<T> = Result<T, SecretStoreError>;

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(windows, allow(dead_code))]
pub enum SecretStoreStatus {
    Available,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(windows, allow(dead_code))]
pub enum SecretStoreError {
    InvalidId,
    EmptySecret,
    SecretTooLarge { max_bytes: usize },
    UnsupportedPlatform,
    BackendUnavailable,
    BackendRejected,
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => formatter.write_str("invalid secret id"),
            Self::EmptySecret => formatter.write_str("secret must not be empty"),
            Self::SecretTooLarge { max_bytes } => {
                write!(formatter, "secret exceeds {max_bytes} byte limit")
            }
            Self::UnsupportedPlatform => formatter.write_str("secret store is unsupported"),
            Self::BackendUnavailable => formatter.write_str("secret store backend is unavailable"),
            Self::BackendRejected => {
                formatter.write_str("secret store backend rejected the request")
            }
        }
    }
}

impl std::error::Error for SecretStoreError {}

pub trait SecretStore: Send + Sync {
    fn status(&self) -> SecretStoreResult<SecretStoreStatus>;
    fn set(&self, id: &str, secret: &[u8]) -> SecretStoreResult<()>;
    fn get(&self, id: &str) -> SecretStoreResult<Option<Vec<u8>>>;
    fn delete(&self, id: &str) -> SecretStoreResult<()>;
}

#[derive(Debug, Default)]
#[cfg(test)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<String, Vec<u8>>>,
}

#[cfg(test)]
impl MemorySecretStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn status(&self) -> SecretStoreResult<SecretStoreStatus> {
        Ok(SecretStoreStatus::Available)
    }

    fn set(&self, id: &str, secret: &[u8]) -> SecretStoreResult<()> {
        let id = validate_id(id)?;
        validate_secret(secret)?;
        self.secrets
            .lock()
            .map_err(|_| SecretStoreError::BackendUnavailable)?
            .insert(id.to_owned(), secret.to_vec());
        Ok(())
    }

    fn get(&self, id: &str) -> SecretStoreResult<Option<Vec<u8>>> {
        let id = validate_id(id)?;
        Ok(self
            .secrets
            .lock()
            .map_err(|_| SecretStoreError::BackendUnavailable)?
            .get(id)
            .cloned())
    }

    fn delete(&self, id: &str) -> SecretStoreResult<()> {
        let id = validate_id(id)?;
        self.secrets
            .lock()
            .map_err(|_| SecretStoreError::BackendUnavailable)?
            .remove(id);
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProductionSecretStore;

impl ProductionSecretStore {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl SecretStore for ProductionSecretStore {
    fn status(&self) -> SecretStoreResult<SecretStoreStatus> {
        production_status()
    }

    fn set(&self, id: &str, secret: &[u8]) -> SecretStoreResult<()> {
        production_set(id, secret)
    }

    fn get(&self, id: &str) -> SecretStoreResult<Option<Vec<u8>>> {
        production_get(id)
    }

    fn delete(&self, id: &str) -> SecretStoreResult<()> {
        production_delete(id)
    }
}

fn validate_id(id: &str) -> SecretStoreResult<&str> {
    if id.is_empty()
        || id.len() > MAX_SECRET_ID_LEN
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err(SecretStoreError::InvalidId);
    }
    Ok(id)
}

fn validate_secret(secret: &[u8]) -> SecretStoreResult<()> {
    if secret.is_empty() {
        return Err(SecretStoreError::EmptySecret);
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Err(SecretStoreError::SecretTooLarge {
            max_bytes: MAX_SECRET_BYTES,
        });
    }
    Ok(())
}

fn zero_bytes(bytes: &mut [u8]) {
    for byte in bytes {
        *byte = 0;
    }
}

#[cfg(windows)]
fn production_status() -> SecretStoreResult<SecretStoreStatus> {
    Ok(SecretStoreStatus::Available)
}

#[cfg(not(windows))]
fn production_status() -> SecretStoreResult<SecretStoreStatus> {
    Ok(SecretStoreStatus::Unsupported)
}

#[cfg(windows)]
fn production_set(id: &str, secret: &[u8]) -> SecretStoreResult<()> {
    let id = validate_id(id)?;
    validate_secret(secret)?;
    run_windows_credential_command("set", id, secret).map(|_| ())
}

#[cfg(not(windows))]
fn production_set(id: &str, secret: &[u8]) -> SecretStoreResult<()> {
    let _ = validate_id(id)?;
    validate_secret(secret)?;
    Err(SecretStoreError::UnsupportedPlatform)
}

#[cfg(windows)]
fn production_get(id: &str) -> SecretStoreResult<Option<Vec<u8>>> {
    let id = validate_id(id)?;
    match run_windows_credential_command("get", id, &[])? {
        WindowsCredentialOutput::NotFound => Ok(None),
        WindowsCredentialOutput::Secret(encoded) => {
            let decoded = decode_base64(encoded.trim_end())?;
            let mut encoded_bytes = encoded.into_bytes();
            zero_bytes(&mut encoded_bytes);
            Ok(Some(decoded))
        }
        WindowsCredentialOutput::Ok => Err(SecretStoreError::BackendRejected),
    }
}

#[cfg(not(windows))]
fn production_get(id: &str) -> SecretStoreResult<Option<Vec<u8>>> {
    let _ = validate_id(id)?;
    Err(SecretStoreError::UnsupportedPlatform)
}

#[cfg(windows)]
fn production_delete(id: &str) -> SecretStoreResult<()> {
    let id = validate_id(id)?;
    run_windows_credential_command("delete", id, &[]).map(|_| ())
}

#[cfg(not(windows))]
fn production_delete(id: &str) -> SecretStoreResult<()> {
    let _ = validate_id(id)?;
    Err(SecretStoreError::UnsupportedPlatform)
}

#[cfg(windows)]
#[derive(Debug, Eq, PartialEq)]
enum WindowsCredentialOutput {
    Ok,
    NotFound,
    Secret(String),
}

#[cfg(windows)]
fn run_windows_credential_command(
    operation: &str,
    id: &str,
    secret_stdin: &[u8],
) -> SecretStoreResult<WindowsCredentialOutput> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let target = format!("MeetingRelay:{id}");
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("& {{ {WINDOWS_CREDENTIAL_SCRIPT} }}"),
            operation,
            &target,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    suppress_child_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|_| SecretStoreError::BackendUnavailable)?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(secret_stdin)
            .map_err(|_| SecretStoreError::BackendUnavailable)?;
    }

    let mut output = child
        .wait_with_output()
        .map_err(|_| SecretStoreError::BackendUnavailable)?;
    if !output.status.success() {
        zero_bytes(&mut output.stdout);
        return Err(SecretStoreError::BackendRejected);
    }

    let stdout = String::from_utf8(std::mem::take(&mut output.stdout))
        .map_err(|_| SecretStoreError::BackendRejected)?;
    match stdout.trim_end() {
        "OK" => Ok(WindowsCredentialOutput::Ok),
        "NOT_FOUND" => Ok(WindowsCredentialOutput::NotFound),
        "" => Err(SecretStoreError::BackendRejected),
        encoded => Ok(WindowsCredentialOutput::Secret(encoded.to_owned())),
    }
}

#[cfg(windows)]
fn suppress_child_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
const WINDOWS_CREDENTIAL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$operation = $args[0]
$targetName = $args[1]
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MeetingRelayCredentialManager
{
    private const UInt32 CredentialTypeGeneric = 1;
    private const UInt32 CredentialPersistLocalMachine = 2;
    private const Int32 ErrorNotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWriteW(ref Credential credential, UInt32 flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredReadW(
        string targetName,
        UInt32 type,
        UInt32 flags,
        out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDeleteW(string targetName, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    public static void WriteSecret(string targetName, byte[] secret)
    {
        IntPtr blob = Marshal.AllocHGlobal(secret.Length);
        try
        {
            Marshal.Copy(secret, 0, blob, secret.Length);
            Credential credential = new Credential
            {
                Type = CredentialTypeGeneric,
                TargetName = targetName,
                CredentialBlobSize = (UInt32)secret.Length,
                CredentialBlob = blob,
                Persist = CredentialPersistLocalMachine,
                UserName = Environment.UserName
            };
            if (!CredWriteW(ref credential, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            for (int index = 0; index < secret.Length; index++)
            {
                Marshal.WriteByte(blob, index, 0);
                secret[index] = 0;
            }
            Marshal.FreeHGlobal(blob);
        }
    }

    public static byte[] ReadSecret(string targetName)
    {
        IntPtr credentialPtr;
        if (!CredReadW(targetName, CredentialTypeGeneric, 0, out credentialPtr))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound)
            {
                return null;
            }
            throw new Win32Exception(error);
        }

        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(
                credentialPtr,
                typeof(Credential));
            byte[] secret = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
            return secret;
        }
        finally
        {
            CredFree(credentialPtr);
        }
    }

    public static void DeleteSecret(string targetName)
    {
        if (!CredDeleteW(targetName, CredentialTypeGeneric, 0))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorNotFound)
            {
                throw new Win32Exception(error);
            }
        }
    }
}
'@

if ($operation -eq 'set') {
    $inputStream = [Console]::OpenStandardInput()
    $memoryStream = [IO.MemoryStream]::new()
    $inputStream.CopyTo($memoryStream)
    $secret = $memoryStream.ToArray()
    try {
        [MeetingRelayCredentialManager]::WriteSecret($targetName, $secret)
        [Console]::Out.WriteLine('OK')
    } finally {
        if ($null -ne $secret) {
            [Array]::Clear($secret, 0, $secret.Length)
        }
        $memoryStream.Dispose()
    }
} elseif ($operation -eq 'get') {
    $secret = [MeetingRelayCredentialManager]::ReadSecret($targetName)
    if ($null -eq $secret) {
        [Console]::Out.WriteLine('NOT_FOUND')
    } else {
        try {
            [Console]::Out.WriteLine([Convert]::ToBase64String($secret))
        } finally {
            [Array]::Clear($secret, 0, $secret.Length)
        }
    }
} elseif ($operation -eq 'delete') {
    [MeetingRelayCredentialManager]::DeleteSecret($targetName)
    [Console]::Out.WriteLine('OK')
} else {
    exit 64
}
"#;

#[cfg(windows)]
fn decode_base64(input: &str) -> SecretStoreResult<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len().saturating_mul(3) / 4);
    let mut chunk = [0_u8; 4];
    let mut chunk_len = 0;

    for byte in input.bytes() {
        chunk[chunk_len] = base64_value(byte)?;
        chunk_len += 1;
        if chunk_len == 4 {
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                output.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if chunk[3] != 64 {
                output.push((chunk[2] << 6) | chunk[3]);
            }
            chunk_len = 0;
        }
    }

    if chunk_len == 0 {
        Ok(output)
    } else {
        Err(SecretStoreError::BackendRejected)
    }
}

#[cfg(windows)]
fn base64_value(byte: u8) -> SecretStoreResult<u8> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        b'=' => Ok(64),
        _ => Err(SecretStoreError::BackendRejected),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_secret_ids() {
        let store = MemorySecretStore::new();

        assert_eq!(store.set("", b"secret"), Err(SecretStoreError::InvalidId));
        assert_eq!(
            store.set("tenant credential", b"secret"),
            Err(SecretStoreError::InvalidId)
        );
        assert_eq!(
            store.set(&"a".repeat(MAX_SECRET_ID_LEN + 1), b"secret"),
            Err(SecretStoreError::InvalidId)
        );
        assert!(store.set("tenant:openai.api_key-1", b"secret").is_ok());
    }

    #[test]
    fn validates_secret_size() {
        let store = MemorySecretStore::new();

        assert_eq!(store.set("openai", b""), Err(SecretStoreError::EmptySecret));
        assert_eq!(
            store.set("openai", &vec![7; MAX_SECRET_BYTES + 1]),
            Err(SecretStoreError::SecretTooLarge {
                max_bytes: MAX_SECRET_BYTES
            })
        );
    }

    #[test]
    fn memory_store_round_trip_and_delete_are_idempotent() {
        let store = MemorySecretStore::new();

        store.set("openai", b"first").expect("set first secret");
        assert_eq!(
            store.get("openai").expect("get first secret"),
            Some(b"first".to_vec())
        );

        store.set("openai", b"second").expect("replace secret");
        assert_eq!(
            store.get("openai").expect("get second secret"),
            Some(b"second".to_vec())
        );

        store.delete("openai").expect("delete secret");
        store.delete("openai").expect("delete missing secret");
        assert_eq!(store.get("openai").expect("get deleted secret"), None);
    }

    #[test]
    fn errors_do_not_include_secret_material() {
        let secret = "super-secret-api-key";
        let error = MemorySecretStore::new()
            .set("openai", secret.repeat(MAX_SECRET_BYTES).as_bytes())
            .expect_err("oversized secret rejected");
        let debug = format!("{error:?}");
        let display = error.to_string();

        assert!(!debug.contains(secret));
        assert!(!display.contains(secret));
    }

    #[cfg(windows)]
    #[test]
    fn powershell_credential_commands_use_no_window_flag() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[cfg(windows)]
    #[test]
    fn decodes_powershell_base64_output() {
        assert_eq!(
            decode_base64("c2VjcmV0AA==").expect("valid base64"),
            b"secret\0"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes a temporary Windows Credential Manager entry"]
    fn windows_credential_manager_round_trip() {
        let store = ProductionSecretStore::new();
        let id = format!(
            "integration:{}:{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after unix epoch")
                .as_nanos()
        );

        let cleanup = || store.delete(&id);
        let result = (|| {
            store.set(&id, b"credential-manager-secret")?;
            let secret = store.get(&id)?;
            assert_eq!(secret, Some(b"credential-manager-secret".to_vec()));
            store.delete(&id)?;
            assert_eq!(store.get(&id)?, None);
            SecretStoreResult::Ok(())
        })();
        let _ = cleanup();
        result.expect("windows credential manager round trip");
    }
}
