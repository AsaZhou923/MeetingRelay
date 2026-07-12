use std::collections::BTreeSet;
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

use sha2::{Digest, Sha256};

const SEALED_FILES: &[(&str, u64, &str)] = &[
    (
        "onnxruntime.dll",
        17_363_968,
        "daa77083a45bf525da0dde9e87f85d8eb146f58f9c9aa7124ca84545e1c0f148",
    ),
    (
        "onnxruntime.lib",
        2_124,
        "b9fc3cd678257d88a111b0773ede4bfceaf0fe95daab4379f2b2b37348a68781",
    ),
    (
        "onnxruntime_providers_shared.dll",
        104_960,
        "190d10767c321f324d3785368a0b752d9c5a9e06cb5d4d97bb176f58bdb652f3",
    ),
    (
        "sherpa-onnx-c-api.dll",
        4_544_512,
        "3db688ca9e6408c958f45986adc68ed9158522e28c7567b7ffee9312a553c777",
    ),
    (
        "sherpa-onnx-c-api.lib",
        75_298,
        "21513d9d053ea39956081f5d421d610cd512b076032bf550b9907d2c7b6a52fb",
    ),
    (
        "sherpa-onnx-cxx-api.dll",
        258_048,
        "3e8b308e9235a3e7398b2c89b43ebb7f813f216aade661b2f246d42656517777",
    ),
    (
        "sherpa-onnx-cxx-api.lib",
        224_022,
        "9b754db267f88e928f77b39afcc9875985e7d51063d0839162e01fb681dd9faf",
    ),
];

fn main() {
    if let Err(error) = run() {
        panic!("MeetingRelay sherpa native build gate failed: {error}");
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_LIB_DIR");
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_NATIVE_SHERPA").is_none() {
        return Ok(());
    }
    require_target()?;
    let lib_dir =
        PathBuf::from(env::var_os("SHERPA_ONNX_LIB_DIR").ok_or(
            "SHERPA_ONNX_LIB_DIR is required; run tools/sherpa-native/materialize.ps1 first",
        )?);
    verify_inventory(&lib_dir)?;
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let sealed_lib_dir = seal_runtime_inventory(&lib_dir, &out_dir)?;
    verify_inventory(&sealed_lib_dir)?;
    println!(
        "cargo:rustc-link-search=native={}",
        sealed_lib_dir.display()
    );
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    println!("cargo:rustc-link-lib=dylib=onnxruntime");
    verify_inventory(&sealed_lib_dir)?;
    stage_runtime_dlls(&sealed_lib_dir)?;
    Ok(())
}

fn require_target() -> Result<(), Box<dyn Error>> {
    let os = env::var("CARGO_CFG_TARGET_OS")?;
    let arch = env::var("CARGO_CFG_TARGET_ARCH")?;
    let target_env = env::var("CARGO_CFG_TARGET_ENV")?;
    if os == "windows" && arch == "x86_64" && target_env == "msvc" {
        Ok(())
    } else {
        Err(format!(
            "WP-0.4.3b is locked to x86_64-pc-windows-msvc, got os={os} arch={arch} env={target_env}"
        )
        .into())
    }
}

fn verify_inventory(lib_dir: &Path) -> Result<(), Box<dyn Error>> {
    reject_reparse_in_existing_chain(lib_dir)?;
    let root_metadata = fs::symlink_metadata(lib_dir).map_err(|error| {
        format!(
            "sealed runtime directory is missing or unreadable: {}: {error}",
            lib_dir.display()
        )
    })?;
    if !root_metadata.is_dir() || is_reparse_point(&root_metadata) {
        return Err(format!(
            "sealed runtime root is not a regular non-reparse directory: {}",
            lib_dir.display()
        )
        .into());
    }
    let expected_names: BTreeSet<&str> = SEALED_FILES.iter().map(|entry| entry.0).collect();
    let mut actual_names = BTreeSet::new();
    for entry in fs::read_dir(lib_dir)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(format!(
                "sealed runtime directory contains a non-regular entry: {}",
                entry.path().display()
            )
            .into());
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "runtime filename is not Unicode")?;
        actual_names.insert(name);
    }
    if actual_names.len() != expected_names.len()
        || actual_names
            .iter()
            .map(String::as_str)
            .ne(expected_names.iter().copied())
    {
        return Err("runtime directory differs from the complete sealed inventory".into());
    }
    for &(name, size, expected_sha256) in SEALED_FILES {
        let path = lib_dir.join(name);
        verify_file_identity(&path, size, expected_sha256)?;
        println!("cargo:rerun-if-changed={}", path.display());
    }
    Ok(())
}

fn verify_file_identity(
    path: &Path,
    size: u64,
    expected_sha256: &str,
) -> Result<(), Box<dyn Error>> {
    reject_reparse_in_existing_chain(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
        || metadata.len() != size
        || sha256_file(path)? != expected_sha256
    {
        return Err(format!(
            "runtime file differs from the sealed inventory: {}",
            path.display()
        )
        .into());
    }
    Ok(())
}

fn seal_runtime_inventory(source: &Path, out_dir: &Path) -> Result<PathBuf, Box<dyn Error>> {
    reject_reparse_in_existing_chain(out_dir)?;
    let sealed = out_dir.join("sealed-sherpa-runtime");
    match fs::symlink_metadata(&sealed) {
        Ok(_) => {
            verify_inventory(&sealed)?;
            return Ok(sealed);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    reject_reparse_in_existing_chain(&sealed)?;
    fs::create_dir(&sealed)?;
    reject_reparse_in_existing_chain(&sealed)?;
    for &(name, size, expected_sha256) in SEALED_FILES {
        let source_file = source.join(name);
        verify_file_identity(&source_file, size, expected_sha256)?;
        let destination = sealed.join(name);
        fs::copy(&source_file, &destination)?;
        verify_file_identity(&destination, size, expected_sha256)?;
    }
    verify_inventory(&sealed)?;
    Ok(sealed)
}

fn sha256_file(path: &Path) -> Result<String, Box<dyn Error>> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}")?;
    }
    Ok(output)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn reject_reparse_in_existing_chain(path: &Path) -> Result<(), Box<dyn Error>> {
    let mut ancestors: Vec<&Path> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                    return Err(format!(
                        "runtime path chain contains a reparse point: {}",
                        ancestor.display()
                    )
                    .into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn remove_existing_regular_file(path: &Path) -> Result<(), Box<dyn Error>> {
    reject_reparse_in_existing_chain(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(format!(
            "refusing to replace a non-regular or reparse destination: {}",
            path.display()
        )
        .into());
    }
    fs::remove_file(path)?;
    Ok(())
}

fn stage_runtime_dlls(lib_dir: &Path) -> Result<(), Box<dyn Error>> {
    verify_inventory(lib_dir)?;
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let profile = env::var("PROFILE")?;
    let profile_dir = out_dir
        .ancestors()
        .find(|path| path.file_name() == Some(OsStr::new(&profile)))
        .ok_or_else(|| {
            format!(
                "cannot locate Cargo profile directory from {}",
                out_dir.display()
            )
        })?
        .to_path_buf();
    for destination in [
        profile_dir.clone(),
        profile_dir.join("deps"),
        profile_dir.join("examples"),
    ] {
        reject_reparse_in_existing_chain(&destination)?;
        fs::create_dir_all(&destination)?;
        reject_reparse_in_existing_chain(&destination)?;
        for &(name, _, _) in SEALED_FILES
            .iter()
            .filter(|entry| entry.0.ends_with(".dll"))
        {
            let (_, size, expected_sha256) = SEALED_FILES
                .iter()
                .find(|entry| entry.0 == name)
                .ok_or("sealed DLL record disappeared")?;
            let source = lib_dir.join(name);
            verify_file_identity(&source, *size, expected_sha256)?;
            let target = destination.join(name);
            let partial = destination.join(format!(".{name}.meetingrelay-part"));
            remove_existing_regular_file(&partial)?;
            fs::copy(&source, &partial)?;
            verify_file_identity(&partial, *size, expected_sha256)?;
            remove_existing_regular_file(&target)?;
            fs::rename(&partial, &target)?;
            verify_file_identity(&target, *size, expected_sha256)?;
        }
    }
    Ok(())
}
