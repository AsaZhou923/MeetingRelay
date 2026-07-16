#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <wincrypt.h>
#include <fcntl.h>
#include <io.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/*
 * Windows-only controlled-root trust primitive for WP-0.4.3n.
 * Successful stdout is one fixed, text-free ASCII receipt line. Failures
 * intentionally emit nothing. Deletion is performed only through an opened
 * file handle with SetFileInformationByHandle; this source never invokes a
 * pathname deletion API.
 */

enum attestor_exit_code {
    ATTESTOR_OK = 0,
    ATTESTOR_USAGE = 64,
    ATTESTOR_ROOT = 65,
    ATTESTOR_VOLUME = 66,
    ATTESTOR_SECURITY = 67,
    ATTESTOR_REPARSE = 68,
    ATTESTOR_INVENTORY = 69,
    ATTESTOR_INPUT = 70,
    ATTESTOR_CREATE = 71,
    ATTESTOR_IDENTITY = 72,
    ATTESTOR_DELETE = 73,
    ATTESTOR_REPLACED = 74,
    ATTESTOR_OUTPUT = 75
};

#define ARRAY_COUNT(value) (sizeof(value) / sizeof((value)[0]))
#define MAX_PATH_CHARS 32768U
#define MAX_INVENTORY_ENTRIES 4096ULL
#define MAX_INVENTORY_DEPTH 32U
#define MAX_CREATE_BYTES (1024ULL * 1024ULL)
#define MAX_RETENTION_BYTES 32UL
#define MAX_RETENTION_SECONDS (30ULL * 24ULL * 60ULL * 60ULL)
#define WINDOWS_TO_UNIX_EPOCH_100NS 116444736000000000ULL
#define SHA256_BYTES 32U
#define SHA256_HEX_CHARS 64U
#define FILE_ID_HEX_CHARS 32U

static const wchar_t RETENTION_MARKER_NAME[] =
    L".meetingrelay-retention-v1";

struct crypto_hash {
    HCRYPTPROV provider;
    HCRYPTHASH hash;
};

struct file_identity {
    uint64_t volume_serial;
    FILE_ID_128 file_id;
};

struct inventory_result {
    BYTE sha256[SHA256_BYTES];
    uint64_t count;
    uint64_t bytes;
};

struct root_attestation {
    wchar_t path[MAX_PATH_CHARS];
    HANDLE handle;
    struct file_identity identity;
    BYTE owner_sid_sha256[SHA256_BYTES];
    BYTE dacl_sha256[SHA256_BYTES];
    struct inventory_result inventory;
    uint64_t retention_expires_unix_seconds;
};

struct listed_entry {
    wchar_t name[MAX_PATH];
    DWORD attributes;
};

static BOOL crypto_hash_start(struct crypto_hash *state) {
    if (state == NULL) {
        return FALSE;
    }
    ZeroMemory(state, sizeof(*state));
    if (!CryptAcquireContextW(
            &state->provider,
            NULL,
            MS_ENH_RSA_AES_PROV_W,
            PROV_RSA_AES,
            CRYPT_VERIFYCONTEXT)) {
        return FALSE;
    }
    if (!CryptCreateHash(
            state->provider,
            CALG_SHA_256,
            0,
            0,
            &state->hash)) {
        (void)CryptReleaseContext(state->provider, 0);
        ZeroMemory(state, sizeof(*state));
        return FALSE;
    }
    return TRUE;
}

static void crypto_hash_abort(struct crypto_hash *state) {
    if (state == NULL) {
        return;
    }
    if (state->hash != 0) {
        (void)CryptDestroyHash(state->hash);
    }
    if (state->provider != 0) {
        (void)CryptReleaseContext(state->provider, 0);
    }
    ZeroMemory(state, sizeof(*state));
}

static BOOL crypto_hash_update(
    struct crypto_hash *state,
    const void *bytes,
    size_t length) {
    const BYTE *cursor = (const BYTE *)bytes;
    size_t remaining = length;
    if (state == NULL || state->hash == 0 ||
        (bytes == NULL && length != 0U)) {
        return FALSE;
    }
    while (remaining > 0U) {
        DWORD chunk = remaining > (size_t)MAXDWORD
            ? MAXDWORD
            : (DWORD)remaining;
        if (!CryptHashData(state->hash, cursor, chunk, 0)) {
            return FALSE;
        }
        cursor += chunk;
        remaining -= (size_t)chunk;
    }
    return TRUE;
}

static BOOL crypto_hash_finish(
    struct crypto_hash *state,
    BYTE output[SHA256_BYTES]) {
    DWORD length = SHA256_BYTES;
    BOOL ok;
    if (state == NULL || output == NULL || state->hash == 0) {
        return FALSE;
    }
    ok = CryptGetHashParam(state->hash, HP_HASHVAL, output, &length, 0) &&
        length == SHA256_BYTES;
    crypto_hash_abort(state);
    return ok;
}

static BOOL sha256_buffer(
    const void *bytes,
    size_t length,
    BYTE output[SHA256_BYTES]) {
    struct crypto_hash state;
    if (!crypto_hash_start(&state)) {
        return FALSE;
    }
    if (!crypto_hash_update(&state, bytes, length)) {
        crypto_hash_abort(&state);
        return FALSE;
    }
    return crypto_hash_finish(&state, output);
}

static void bytes_to_hex(
    const BYTE *bytes,
    size_t length,
    char *output,
    size_t output_capacity) {
    static const char HEX[] = "0123456789abcdef";
    size_t index;
    if (bytes == NULL || output == NULL ||
        output_capacity < length * 2U + 1U) {
        return;
    }
    for (index = 0U; index < length; ++index) {
        output[index * 2U] = HEX[(bytes[index] >> 4U) & 0x0fU];
        output[index * 2U + 1U] = HEX[bytes[index] & 0x0fU];
    }
    output[length * 2U] = '\0';
}

static BOOL parse_lower_hex(
    const wchar_t *text,
    BYTE *output,
    size_t output_length) {
    size_t index;
    if (text == NULL || output == NULL ||
        wcslen(text) != output_length * 2U) {
        return FALSE;
    }
    for (index = 0U; index < output_length; ++index) {
        wchar_t high = text[index * 2U];
        wchar_t low = text[index * 2U + 1U];
        unsigned high_value;
        unsigned low_value;
        if (high >= L'0' && high <= L'9') {
            high_value = (unsigned)(high - L'0');
        } else if (high >= L'a' && high <= L'f') {
            high_value = (unsigned)(high - L'a') + 10U;
        } else {
            return FALSE;
        }
        if (low >= L'0' && low <= L'9') {
            low_value = (unsigned)(low - L'0');
        } else if (low >= L'a' && low <= L'f') {
            low_value = (unsigned)(low - L'a') + 10U;
        } else {
            return FALSE;
        }
        output[index] = (BYTE)((high_value << 4U) | low_value);
    }
    return TRUE;
}

static BOOL parse_u64(
    const wchar_t *text,
    uint64_t maximum,
    uint64_t *value) {
    const wchar_t *cursor;
    uint64_t result = 0ULL;
    if (text == NULL || text[0] == L'\0' || value == NULL ||
        (text[0] == L'0' && text[1] != L'\0')) {
        return FALSE;
    }
    for (cursor = text; *cursor != L'\0'; ++cursor) {
        unsigned digit;
        if (*cursor < L'0' || *cursor > L'9') {
            return FALSE;
        }
        digit = (unsigned)(*cursor - L'0');
        if (result > (maximum - (uint64_t)digit) / 10ULL) {
            return FALSE;
        }
        result = result * 10ULL + (uint64_t)digit;
    }
    if (result == 0ULL) {
        return FALSE;
    }
    *value = result;
    return TRUE;
}

static BOOL parse_volume_serial(const wchar_t *text, uint64_t *value) {
    uint64_t result = 0ULL;
    size_t index;
    if (text == NULL || value == NULL || wcslen(text) != 16U) {
        return FALSE;
    }
    for (index = 0U; index < 16U; ++index) {
        wchar_t digit = text[index];
        unsigned numeric;
        if (digit >= L'0' && digit <= L'9') {
            numeric = (unsigned)(digit - L'0');
        } else if (digit >= L'a' && digit <= L'f') {
            numeric = (unsigned)(digit - L'a') + 10U;
        } else {
            return FALSE;
        }
        result = (result << 4U) | (uint64_t)numeric;
    }
    *value = result;
    return TRUE;
}

static BOOL file_id_equal(
    const FILE_ID_128 *left,
    const FILE_ID_128 *right) {
    return left != NULL && right != NULL &&
        memcmp(
            left->Identifier,
            right->Identifier,
            sizeof(left->Identifier)) == 0;
}

static BOOL file_identity_from_handle(
    HANDLE handle,
    struct file_identity *identity) {
    FILE_ID_INFO information;
    if (handle == NULL || handle == INVALID_HANDLE_VALUE || identity == NULL ||
        !GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            &information,
            (DWORD)sizeof(information))) {
        return FALSE;
    }
    identity->volume_serial = (uint64_t)information.VolumeSerialNumber;
    identity->file_id = information.FileId;
    return TRUE;
}

static BOOL handle_is_non_reparse(HANDLE handle, BOOL require_directory) {
    FILE_ATTRIBUTE_TAG_INFO tag;
    if (handle == NULL || handle == INVALID_HANDLE_VALUE ||
        !GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            &tag,
            (DWORD)sizeof(tag)) ||
        (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0UL) {
        return FALSE;
    }
    if (require_directory) {
        return (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0UL;
    }
    return (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0UL;
}

static HANDLE open_no_reparse(
    const wchar_t *path,
    BOOL directory,
    DWORD access) {
    DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if (directory) {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    return CreateFileW(
        path,
        access,
        FILE_SHARE_READ,
        NULL,
        OPEN_EXISTING,
        flags,
        NULL);
}

static BOOL canonical_drive_path(
    const wchar_t *input,
    wchar_t output[MAX_PATH_CHARS]) {
    DWORD length;
    size_t input_length;
    if (input == NULL || input[0] == L'\0' || input[1] != L':' ||
        input[2] != L'\\' || input[3] == L'\0' ||
        wcschr(input + 2, L':') != NULL || wcschr(input, L'/') != NULL) {
        return FALSE;
    }
    input_length = wcslen(input);
    if (input_length >= MAX_PATH_CHARS ||
        input[input_length - 1U] == L'\\') {
        return FALSE;
    }
    length = GetFullPathNameW(input, MAX_PATH_CHARS, output, NULL);
    return length > 0UL && length < MAX_PATH_CHARS &&
        _wcsicmp(input, output) == 0;
}

static BOOL reject_reparse_ancestors(const wchar_t *path) {
    wchar_t current[MAX_PATH_CHARS];
    size_t length = wcslen(path);
    size_t index;
    if (length >= MAX_PATH_CHARS) {
        return FALSE;
    }
    ZeroMemory(current, sizeof(current));
    current[0] = path[0];
    current[1] = L':';
    current[2] = L'\\';
    current[3] = L'\0';
    for (index = 3U; index <= length; ++index) {
        HANDLE handle;
        if (index < length && path[index] != L'\\') {
            continue;
        }
        if (index > 3U) {
            memcpy(current, path, index * sizeof(wchar_t));
            current[index] = L'\0';
        }
        handle = open_no_reparse(current, TRUE, FILE_READ_ATTRIBUTES);
        if (handle == INVALID_HANDLE_VALUE) {
            return FALSE;
        }
        if (!handle_is_non_reparse(handle, TRUE)) {
            (void)CloseHandle(handle);
            return FALSE;
        }
        if (!CloseHandle(handle)) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL get_current_operator_sid(BYTE **storage, PSID *sid) {
    HANDLE token = NULL;
    DWORD required = 0UL;
    BYTE *allocated;
    if (storage == NULL || sid == NULL ||
        !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return FALSE;
    }
    (void)GetTokenInformation(token, TokenUser, NULL, 0UL, &required);
    if (required == 0UL) {
        (void)CloseHandle(token);
        return FALSE;
    }
    allocated = (BYTE *)HeapAlloc(
        GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)required);
    if (allocated == NULL ||
        !GetTokenInformation(
            token,
            TokenUser,
            allocated,
            required,
            &required)) {
        if (allocated != NULL) {
            (void)HeapFree(GetProcessHeap(), 0UL, allocated);
        }
        (void)CloseHandle(token);
        return FALSE;
    }
    (void)CloseHandle(token);
    *storage = allocated;
    *sid = ((TOKEN_USER *)allocated)->User.Sid;
    return IsValidSid(*sid);
}

static BOOL hash_exact_dacl(
    HANDLE root_handle,
    BOOL directory,
    BOOL allow_inherited,
    BYTE owner_digest[SHA256_BYTES],
    BYTE dacl_digest[SHA256_BYTES]) {
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL dacl = NULL;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0UL;
    ACL_SIZE_INFORMATION acl_information;
    BYTE *operator_storage = NULL;
    PSID operator_sid = NULL;
    BYTE system_sid[SECURITY_MAX_SID_SIZE];
    BYTE administrators_sid[SECURITY_MAX_SID_SIZE];
    DWORD system_sid_length = (DWORD)sizeof(system_sid);
    DWORD administrators_sid_length = (DWORD)sizeof(administrators_sid);
    BOOL seen[3] = {FALSE, FALSE, FALSE};
    DWORD masks[3] = {0UL, 0UL, 0UL};
    BYTE flags[3] = {0U, 0U, 0U};
    DWORD index;
    struct crypto_hash hash;
    static const char MAGIC[] = "meetingrelay-controlled-root-dacl-v1";
    BYTE expected_flags;
    BYTE protection_byte;
    BOOL protected_dacl;
    BOOL ok = FALSE;

    if (GetSecurityInfo(
            root_handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &owner,
            NULL,
            &dacl,
            NULL,
            &descriptor) != ERROR_SUCCESS ||
        descriptor == NULL || owner == NULL || dacl == NULL ||
        !GetSecurityDescriptorControl(descriptor, &control, &revision) ||
        (control & SE_DACL_PRESENT) == 0 ||
        !get_current_operator_sid(&operator_storage, &operator_sid) ||
        !EqualSid(owner, operator_sid) ||
        !CreateWellKnownSid(
            WinLocalSystemSid,
            NULL,
            system_sid,
            &system_sid_length) ||
        !CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            NULL,
            administrators_sid,
            &administrators_sid_length) ||
        !GetAclInformation(
            dacl,
            &acl_information,
            (DWORD)sizeof(acl_information),
            AclSizeInformation) ||
        acl_information.AceCount != 3UL) {
        goto cleanup;
    }
    protected_dacl = (control & SE_DACL_PROTECTED) != 0;
    if (!allow_inherited && !protected_dacl) {
        goto cleanup;
    }
    expected_flags = directory
        ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
        : 0U;
    if (!protected_dacl) {
        expected_flags |= INHERITED_ACE;
    }
    protection_byte = protected_dacl ? 1U : 0U;

    for (index = 0UL; index < acl_information.AceCount; ++index) {
        void *raw_ace = NULL;
        ACCESS_ALLOWED_ACE *ace;
        PSID ace_sid;
        int role = -1;
        if (!GetAce(dacl, index, &raw_ace) || raw_ace == NULL) {
            goto cleanup;
        }
        ace = (ACCESS_ALLOWED_ACE *)raw_ace;
        if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
            ace->Header.AceFlags != expected_flags ||
            ace->Mask != FILE_ALL_ACCESS) {
            goto cleanup;
        }
        ace_sid = (PSID)&ace->SidStart;
        if (!IsValidSid(ace_sid)) {
            goto cleanup;
        }
        if (EqualSid(ace_sid, operator_sid)) {
            role = 0;
        } else if (EqualSid(ace_sid, system_sid)) {
            role = 1;
        } else if (EqualSid(ace_sid, administrators_sid)) {
            role = 2;
        }
        if (role < 0 || seen[role]) {
            goto cleanup;
        }
        seen[role] = TRUE;
        masks[role] = ace->Mask;
        flags[role] = ace->Header.AceFlags;
    }
    if (!seen[0] || !seen[1] || !seen[2] ||
        !sha256_buffer(
            operator_sid,
            (size_t)GetLengthSid(operator_sid),
            owner_digest) ||
        !crypto_hash_start(&hash)) {
        goto cleanup;
    }
    if (!crypto_hash_update(&hash, MAGIC, sizeof(MAGIC) - 1U) ||
        !crypto_hash_update(
            &hash,
            &protection_byte,
            sizeof(protection_byte))) {
        crypto_hash_abort(&hash);
        goto cleanup;
    }
    for (index = 0UL; index < 3UL; ++index) {
        BYTE role_byte = (BYTE)index;
        if (!crypto_hash_update(&hash, &role_byte, sizeof(role_byte)) ||
            !crypto_hash_update(&hash, &masks[index], sizeof(masks[index])) ||
            !crypto_hash_update(&hash, &flags[index], sizeof(flags[index]))) {
            crypto_hash_abort(&hash);
            goto cleanup;
        }
    }
    if (!crypto_hash_finish(&hash, dacl_digest)) {
        goto cleanup;
    }
    ok = TRUE;

cleanup:
    if (operator_storage != NULL) {
        (void)HeapFree(GetProcessHeap(), 0UL, operator_storage);
    }
    if (descriptor != NULL) {
        (void)LocalFree(descriptor);
    }
    return ok;
}

static BOOL apply_exact_dacl(HANDLE handle, BOOL directory) {
    BYTE *operator_storage = NULL;
    PSID operator_sid = NULL;
    BYTE system_sid[SECURITY_MAX_SID_SIZE];
    BYTE administrators_sid[SECURITY_MAX_SID_SIZE];
    DWORD system_sid_length = (DWORD)sizeof(system_sid);
    DWORD administrators_sid_length = (DWORD)sizeof(administrators_sid);
    PSID principals[3];
    EXPLICIT_ACCESSW entries[3];
    PACL dacl = NULL;
    DWORD inheritance = directory
        ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
        : NO_INHERITANCE;
    DWORD index;
    DWORD status;
    BOOL ok = FALSE;

    ZeroMemory(entries, sizeof(entries));
    if (!get_current_operator_sid(&operator_storage, &operator_sid) ||
        !CreateWellKnownSid(
            WinLocalSystemSid,
            NULL,
            system_sid,
            &system_sid_length) ||
        !CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            NULL,
            administrators_sid,
            &administrators_sid_length)) {
        goto cleanup;
    }
    principals[0] = operator_sid;
    principals[1] = system_sid;
    principals[2] = administrators_sid;
    for (index = 0UL; index < 3UL; ++index) {
        entries[index].grfAccessPermissions = FILE_ALL_ACCESS;
        entries[index].grfAccessMode = SET_ACCESS;
        entries[index].grfInheritance = inheritance;
        BuildTrusteeWithSidW(&entries[index].Trustee, principals[index]);
        entries[index].Trustee.TrusteeType = index == 0UL
            ? TRUSTEE_IS_USER
            : TRUSTEE_IS_GROUP;
    }
    status = SetEntriesInAclW(3UL, entries, NULL, &dacl);
    if (status != ERROR_SUCCESS || dacl == NULL) {
        goto cleanup;
    }
    status = SetSecurityInfo(
        handle,
        SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
            PROTECTED_DACL_SECURITY_INFORMATION,
        operator_sid,
        NULL,
        dacl,
        NULL);
    ok = status == ERROR_SUCCESS;

cleanup:
    if (dacl != NULL) {
        (void)LocalFree(dacl);
    }
    if (operator_storage != NULL) {
        (void)HeapFree(GetProcessHeap(), 0UL, operator_storage);
    }
    return ok;
}

static int compare_listed_entries(const void *left_value, const void *right_value) {
    const struct listed_entry *left =
        (const struct listed_entry *)left_value;
    const struct listed_entry *right =
        (const struct listed_entry *)right_value;
    int insensitive = _wcsicmp(left->name, right->name);
    return insensitive != 0 ? insensitive : wcscmp(left->name, right->name);
}

static BOOL append_path(
    const wchar_t *parent,
    const wchar_t *name,
    wchar_t output[MAX_PATH_CHARS]) {
    int written;
    if (parent == NULL || name == NULL || output == NULL) {
        return FALSE;
    }
    written = swprintf_s(output, MAX_PATH_CHARS, L"%ls\\%ls", parent, name);
    return written > 0 && (size_t)written < MAX_PATH_CHARS;
}

static BOOL inventory_hash_entry(
    struct crypto_hash *hash,
    const wchar_t *relative_path,
    const FILE_ATTRIBUTE_TAG_INFO *tag,
    const BY_HANDLE_FILE_INFORMATION *basic,
    const struct file_identity *identity,
    const BYTE owner_digest[SHA256_BYTES],
    const BYTE dacl_digest[SHA256_BYTES],
    BOOL directory) {
    size_t path_length = wcslen(relative_path);
    uint32_t path_characters;
    BYTE kind = directory ? (BYTE)'D' : (BYTE)'F';
    uint64_t size = ((uint64_t)basic->nFileSizeHigh << 32U) |
        (uint64_t)basic->nFileSizeLow;
    if (path_length > UINT32_MAX) {
        return FALSE;
    }
    path_characters = (uint32_t)path_length;
    return crypto_hash_update(hash, &path_characters, sizeof(path_characters)) &&
        crypto_hash_update(
            hash,
            relative_path,
            path_length * sizeof(wchar_t)) &&
        crypto_hash_update(hash, &kind, sizeof(kind)) &&
        crypto_hash_update(
            hash,
            &tag->FileAttributes,
            sizeof(tag->FileAttributes)) &&
        crypto_hash_update(
            hash,
            &identity->volume_serial,
            sizeof(identity->volume_serial)) &&
        crypto_hash_update(
            hash,
            identity->file_id.Identifier,
            sizeof(identity->file_id.Identifier)) &&
        crypto_hash_update(hash, owner_digest, SHA256_BYTES) &&
        crypto_hash_update(hash, dacl_digest, SHA256_BYTES) &&
        crypto_hash_update(hash, &size, sizeof(size)) &&
        crypto_hash_update(
            hash,
            &basic->nNumberOfLinks,
            sizeof(basic->nNumberOfLinks));
}

static BOOL scan_directory(
    const wchar_t *directory_path,
    const wchar_t *relative_prefix,
    uint64_t volume_serial,
    unsigned depth,
    struct crypto_hash *hash,
    uint64_t *count,
    uint64_t *bytes) {
    wchar_t pattern[MAX_PATH_CHARS];
    WIN32_FIND_DATAW find_data;
    HANDLE search = INVALID_HANDLE_VALUE;
    struct listed_entry *entries = NULL;
    size_t entry_count = 0U;
    size_t capacity = 0U;
    size_t index;
    BOOL ok = FALSE;
    if (depth > MAX_INVENTORY_DEPTH ||
        swprintf_s(pattern, MAX_PATH_CHARS, L"%ls\\*", directory_path) <= 0) {
        return FALSE;
    }
    search = FindFirstFileExW(
        pattern,
        FindExInfoBasic,
        &find_data,
        FindExSearchNameMatch,
        NULL,
        FIND_FIRST_EX_LARGE_FETCH);
    if (search == INVALID_HANDLE_VALUE) {
        return GetLastError() == ERROR_FILE_NOT_FOUND;
    }
    do {
        struct listed_entry *resized;
        if (wcscmp(find_data.cFileName, L".") == 0 ||
            wcscmp(find_data.cFileName, L"..") == 0) {
            continue;
        }
        if ((find_data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0UL ||
            wcslen(find_data.cFileName) >= MAX_PATH) {
            goto cleanup;
        }
        if (entry_count == capacity) {
            size_t next_capacity = capacity == 0U ? 16U : capacity * 2U;
            if (next_capacity > (size_t)MAX_INVENTORY_ENTRIES) {
                goto cleanup;
            }
            resized = entries == NULL
                ? (struct listed_entry *)HeapAlloc(
                    GetProcessHeap(),
                    HEAP_ZERO_MEMORY,
                    next_capacity * sizeof(*entries))
                : (struct listed_entry *)HeapReAlloc(
                    GetProcessHeap(),
                    HEAP_ZERO_MEMORY,
                    entries,
                    next_capacity * sizeof(*entries));
            if (resized == NULL) {
                goto cleanup;
            }
            entries = resized;
            capacity = next_capacity;
        }
        if (wcscpy_s(
                entries[entry_count].name,
                MAX_PATH,
                find_data.cFileName) != 0) {
            goto cleanup;
        }
        entries[entry_count].attributes = find_data.dwFileAttributes;
        entry_count += 1U;
    } while (FindNextFileW(search, &find_data));
    if (GetLastError() != ERROR_NO_MORE_FILES || !FindClose(search)) {
        search = INVALID_HANDLE_VALUE;
        goto cleanup;
    }
    search = INVALID_HANDLE_VALUE;
    qsort(entries, entry_count, sizeof(*entries), compare_listed_entries);

    for (index = 0U; index < entry_count; ++index) {
        wchar_t child_path[MAX_PATH_CHARS];
        wchar_t relative_path[MAX_PATH_CHARS];
        BOOL directory =
            (entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) != 0UL;
        HANDLE child;
        FILE_ATTRIBUTE_TAG_INFO tag;
        BY_HANDLE_FILE_INFORMATION basic;
        struct file_identity identity;
        BYTE owner_digest[SHA256_BYTES];
        BYTE dacl_digest[SHA256_BYTES];
        uint64_t file_size;
        if (*count >= MAX_INVENTORY_ENTRIES ||
            !append_path(directory_path, entries[index].name, child_path)) {
            goto cleanup;
        }
        if (relative_prefix[0] == L'\0') {
            if (wcscpy_s(
                    relative_path,
                    MAX_PATH_CHARS,
                    entries[index].name) != 0) {
                goto cleanup;
            }
        } else if (swprintf_s(
                       relative_path,
                       MAX_PATH_CHARS,
                       L"%ls\\%ls",
                       relative_prefix,
                       entries[index].name) <= 0) {
            goto cleanup;
        }
        child = open_no_reparse(
            child_path,
            directory,
            FILE_READ_ATTRIBUTES | READ_CONTROL);
        if (child == INVALID_HANDLE_VALUE ||
            !GetFileInformationByHandleEx(
                child,
                FileAttributeTagInfo,
                &tag,
                (DWORD)sizeof(tag)) ||
            !GetFileInformationByHandle(child, &basic) ||
            (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0UL ||
            (((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0UL)
                != directory) ||
            !file_identity_from_handle(child, &identity) ||
            identity.volume_serial != volume_serial ||
            !hash_exact_dacl(
                child,
                directory,
                TRUE,
                owner_digest,
                dacl_digest) ||
            !inventory_hash_entry(
                hash,
                relative_path,
                &tag,
                &basic,
                &identity,
                owner_digest,
                dacl_digest,
                directory)) {
            if (child != INVALID_HANDLE_VALUE) {
                (void)CloseHandle(child);
            }
            goto cleanup;
        }
        *count += 1ULL;
        file_size = ((uint64_t)basic.nFileSizeHigh << 32U) |
            (uint64_t)basic.nFileSizeLow;
        if (!directory) {
            if (UINT64_MAX - *bytes < file_size) {
                (void)CloseHandle(child);
                goto cleanup;
            }
            *bytes += file_size;
        }
        if (directory &&
            !scan_directory(
                child_path,
                relative_path,
                volume_serial,
                depth + 1U,
                hash,
                count,
                bytes)) {
            (void)CloseHandle(child);
            goto cleanup;
        }
        if (!CloseHandle(child)) {
            goto cleanup;
        }
    }
    ok = TRUE;

cleanup:
    if (search != INVALID_HANDLE_VALUE) {
        (void)FindClose(search);
    }
    if (entries != NULL) {
        (void)HeapFree(GetProcessHeap(), 0UL, entries);
    }
    return ok;
}

static BOOL build_inventory(
    const wchar_t *root_path,
    uint64_t volume_serial,
    struct inventory_result *result) {
    struct crypto_hash hash;
    static const char MAGIC[] = "meetingrelay-controlled-root-inventory-v1";
    if (result == NULL || !crypto_hash_start(&hash)) {
        return FALSE;
    }
    result->count = 0ULL;
    result->bytes = 0ULL;
    if (!crypto_hash_update(&hash, MAGIC, sizeof(MAGIC) - 1U) ||
        !scan_directory(
            root_path,
            L"",
            volume_serial,
            0U,
            &hash,
            &result->count,
            &result->bytes)) {
        crypto_hash_abort(&hash);
        return FALSE;
    }
    return crypto_hash_finish(&hash, result->sha256);
}

static BOOL inventory_equal(
    const struct inventory_result *left,
    const struct inventory_result *right) {
    return left != NULL && right != NULL &&
        left->count == right->count && left->bytes == right->bytes &&
        memcmp(left->sha256, right->sha256, SHA256_BYTES) == 0;
}

static uint64_t current_unix_seconds(void) {
    FILETIME time;
    ULARGE_INTEGER value;
    GetSystemTimeAsFileTime(&time);
    value.LowPart = time.dwLowDateTime;
    value.HighPart = time.dwHighDateTime;
    if (value.QuadPart <= WINDOWS_TO_UNIX_EPOCH_100NS) {
        return 0ULL;
    }
    return (value.QuadPart - WINDOWS_TO_UNIX_EPOCH_100NS) / 10000000ULL;
}

static BOOL read_retention_marker(
    const wchar_t *root_path,
    uint64_t volume_serial,
    BOOL allow_expired,
    uint64_t *expires) {
    wchar_t marker_path[MAX_PATH_CHARS];
    HANDLE handle = INVALID_HANDLE_VALUE;
    BY_HANDLE_FILE_INFORMATION basic;
    struct file_identity marker_identity;
    char content[MAX_RETENTION_BYTES + 1UL];
    DWORD read_count = 0UL;
    uint64_t value = 0ULL;
    uint64_t now;
    size_t index;
    BOOL ok = FALSE;
    if (expires == NULL ||
        !append_path(root_path, RETENTION_MARKER_NAME, marker_path)) {
        return FALSE;
    }
    handle = open_no_reparse(
        marker_path,
        FALSE,
        GENERIC_READ | FILE_READ_ATTRIBUTES);
    if (handle == INVALID_HANDLE_VALUE || !handle_is_non_reparse(handle, FALSE) ||
        !GetFileInformationByHandle(handle, &basic) ||
        basic.nNumberOfLinks != 1UL || basic.nFileSizeHigh != 0UL ||
        basic.nFileSizeLow < 2UL || basic.nFileSizeLow > MAX_RETENTION_BYTES ||
        !file_identity_from_handle(handle, &marker_identity) ||
        marker_identity.volume_serial != volume_serial ||
        !ReadFile(handle, content, basic.nFileSizeLow, &read_count, NULL) ||
        read_count != basic.nFileSizeLow) {
        goto cleanup;
    }
    content[read_count] = '\0';
    if (content[read_count - 1UL] != '\n' || content[0] == '0') {
        goto cleanup;
    }
    for (index = 0U; index + 1U < (size_t)read_count; ++index) {
        unsigned digit;
        if (content[index] < '0' || content[index] > '9') {
            goto cleanup;
        }
        digit = (unsigned)(content[index] - '0');
        if (value > (UINT64_MAX - (uint64_t)digit) / 10ULL) {
            goto cleanup;
        }
        value = value * 10ULL + (uint64_t)digit;
    }
    now = current_unix_seconds();
    if (now == 0ULL ||
        (value > now && value - now > MAX_RETENTION_SECONDS) ||
        (!allow_expired && value <= now)) {
        goto cleanup;
    }
    *expires = value;
    ok = TRUE;

cleanup:
    if (handle != INVALID_HANDLE_VALUE && !CloseHandle(handle)) {
        ok = FALSE;
    }
    return ok;
}

static BOOL root_identity_still_matches(
    const struct root_attestation *attestation) {
    struct file_identity current;
    BYTE owner_digest[SHA256_BYTES];
    BYTE dacl_digest[SHA256_BYTES];
    HANDLE path_handle = INVALID_HANDLE_VALUE;
    BOOL ok = FALSE;
    if (attestation == NULL ||
        !file_identity_from_handle(attestation->handle, &current) ||
        current.volume_serial != attestation->identity.volume_serial ||
        !file_id_equal(&attestation->identity.file_id, &current.file_id) ||
        !hash_exact_dacl(
            attestation->handle,
            TRUE,
            FALSE,
            owner_digest,
            dacl_digest) ||
        memcmp(
            owner_digest,
            attestation->owner_sid_sha256,
            SHA256_BYTES) != 0 ||
        memcmp(dacl_digest, attestation->dacl_sha256, SHA256_BYTES) != 0 ||
        !reject_reparse_ancestors(attestation->path)) {
        goto cleanup;
    }
    path_handle = open_no_reparse(
        attestation->path,
        TRUE,
        FILE_READ_ATTRIBUTES | READ_CONTROL);
    if (path_handle == INVALID_HANDLE_VALUE ||
        !handle_is_non_reparse(path_handle, TRUE) ||
        !file_identity_from_handle(path_handle, &current) ||
        current.volume_serial != attestation->identity.volume_serial ||
        !file_id_equal(&attestation->identity.file_id, &current.file_id) ||
        !hash_exact_dacl(
            path_handle,
            TRUE,
            FALSE,
            owner_digest,
            dacl_digest) ||
        memcmp(
            owner_digest,
            attestation->owner_sid_sha256,
            SHA256_BYTES) != 0 ||
        memcmp(dacl_digest, attestation->dacl_sha256, SHA256_BYTES) != 0) {
        goto cleanup;
    }
    ok = TRUE;

cleanup:
    if (path_handle != INVALID_HANDLE_VALUE && !CloseHandle(path_handle)) {
        ok = FALSE;
    }
    return ok;
}

static int attest_root(
    const wchar_t *input_path,
    BOOL allow_expired_retention,
    struct root_attestation *attestation) {
    wchar_t volume_path[MAX_PATH];
    wchar_t filesystem_name[MAX_PATH];
    struct inventory_result second_inventory;
    uint64_t second_retention_expires = 0ULL;
    if (attestation == NULL) {
        return ATTESTOR_ROOT;
    }
    ZeroMemory(attestation, sizeof(*attestation));
    attestation->handle = INVALID_HANDLE_VALUE;
    if (!canonical_drive_path(input_path, attestation->path) ||
        !reject_reparse_ancestors(attestation->path)) {
        return ATTESTOR_REPARSE;
    }
    attestation->handle = open_no_reparse(
        attestation->path,
        TRUE,
        FILE_READ_ATTRIBUTES | READ_CONTROL);
    if (attestation->handle == INVALID_HANDLE_VALUE ||
        !handle_is_non_reparse(attestation->handle, TRUE)) {
        return ATTESTOR_ROOT;
    }
    if (!GetVolumePathNameW(
            attestation->path,
            volume_path,
            (DWORD)ARRAY_COUNT(volume_path)) ||
        GetDriveTypeW(volume_path) != DRIVE_FIXED ||
        !GetVolumeInformationByHandleW(
            attestation->handle,
            NULL,
            0UL,
            NULL,
            NULL,
            NULL,
            filesystem_name,
            (DWORD)ARRAY_COUNT(filesystem_name)) ||
        wcscmp(filesystem_name, L"NTFS") != 0) {
        return ATTESTOR_VOLUME;
    }
    if (!file_identity_from_handle(
            attestation->handle,
            &attestation->identity)) {
        return ATTESTOR_IDENTITY;
    }
    if (!hash_exact_dacl(
            attestation->handle,
            TRUE,
            FALSE,
            attestation->owner_sid_sha256,
            attestation->dacl_sha256)) {
        return ATTESTOR_SECURITY;
    }
    if (!build_inventory(
            attestation->path,
            attestation->identity.volume_serial,
            &attestation->inventory) ||
        !read_retention_marker(
            attestation->path,
            attestation->identity.volume_serial,
            allow_expired_retention,
            &attestation->retention_expires_unix_seconds) ||
        !build_inventory(
            attestation->path,
            attestation->identity.volume_serial,
            &second_inventory) ||
        !read_retention_marker(
            attestation->path,
            attestation->identity.volume_serial,
            allow_expired_retention,
            &second_retention_expires) ||
        !inventory_equal(&attestation->inventory, &second_inventory) ||
        second_retention_expires !=
            attestation->retention_expires_unix_seconds ||
        !root_identity_still_matches(attestation)) {
        return ATTESTOR_INVENTORY;
    }
    return ATTESTOR_OK;
}

static void close_attestation(struct root_attestation *attestation) {
    if (attestation != NULL && attestation->handle != INVALID_HANDLE_VALUE) {
        (void)CloseHandle(attestation->handle);
        attestation->handle = INVALID_HANDLE_VALUE;
    }
}

static BOOL valid_leaf_name(const wchar_t *leaf) {
    size_t length;
    size_t index;
    wchar_t stem[16];
    static const wchar_t *const RESERVED[] = {
        L"CON", L"PRN", L"AUX", L"NUL", L"COM1", L"COM2", L"COM3",
        L"COM4", L"COM5", L"COM6", L"COM7", L"COM8", L"COM9", L"LPT1",
        L"LPT2", L"LPT3", L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8",
        L"LPT9"
    };
    if (leaf == NULL) {
        return FALSE;
    }
    length = wcslen(leaf);
    if (length == 0U || length > 128U || leaf[length - 1U] == L'.' ||
        !((leaf[0] >= L'A' && leaf[0] <= L'Z') ||
          (leaf[0] >= L'a' && leaf[0] <= L'z') ||
          (leaf[0] >= L'0' && leaf[0] <= L'9'))) {
        return FALSE;
    }
    for (index = 0U; index < length; ++index) {
        wchar_t value = leaf[index];
        if (!((value >= L'A' && value <= L'Z') ||
              (value >= L'a' && value <= L'z') ||
              (value >= L'0' && value <= L'9') || value == L'.' ||
              value == L'_' || value == L'-')) {
            return FALSE;
        }
    }
    ZeroMemory(stem, sizeof(stem));
    for (index = 0U; index < length && index < ARRAY_COUNT(stem) - 1U; ++index) {
        wchar_t value = leaf[index];
        if (value == L'.') {
            break;
        }
        stem[index] = value >= L'a' && value <= L'z'
            ? (wchar_t)(value - (L'a' - L'A'))
            : value;
    }
    for (index = 0U; index < ARRAY_COUNT(RESERVED); ++index) {
        if (wcscmp(stem, RESERVED[index]) == 0) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL hash_leaf_name(
    const wchar_t *leaf,
    BYTE output[SHA256_BYTES]) {
    char ascii[129];
    size_t length = wcslen(leaf);
    size_t index;
    if (length == 0U || length > 128U) {
        return FALSE;
    }
    for (index = 0U; index < length; ++index) {
        if (leaf[index] > 0x7f) {
            return FALSE;
        }
        ascii[index] = (char)leaf[index];
    }
    return sha256_buffer(ascii, length, output);
}

static BOOL hash_file_handle(
    HANDLE handle,
    uint64_t expected_size,
    BYTE output[SHA256_BYTES]) {
    struct crypto_hash hash;
    LARGE_INTEGER zero;
    BYTE buffer[64U * 1024U];
    uint64_t total = 0ULL;
    DWORD read_count;
    zero.QuadPart = 0;
    if (!SetFilePointerEx(handle, zero, NULL, FILE_BEGIN) ||
        !crypto_hash_start(&hash)) {
        return FALSE;
    }
    do {
        if (!ReadFile(handle, buffer, (DWORD)sizeof(buffer), &read_count, NULL) ||
            UINT64_MAX - total < (uint64_t)read_count ||
            !crypto_hash_update(&hash, buffer, (size_t)read_count)) {
            crypto_hash_abort(&hash);
            return FALSE;
        }
        total += (uint64_t)read_count;
    } while (read_count != 0UL);
    if (total != expected_size) {
        crypto_hash_abort(&hash);
        return FALSE;
    }
    return crypto_hash_finish(&hash, output);
}

static BOOL mark_handle_for_delete(HANDLE handle) {
    FILE_DISPOSITION_INFO disposition;
    disposition.DeleteFile = TRUE;
    return SetFileInformationByHandle(
        handle,
        FileDispositionInfo,
        &disposition,
        (DWORD)sizeof(disposition));
}

static BOOL write_all(HANDLE handle, const BYTE *bytes, DWORD length) {
    DWORD total = 0UL;
    while (total < length) {
        DWORD written = 0UL;
        if (!WriteFile(handle, bytes + total, length - total, &written, NULL) ||
            written == 0UL) {
            return FALSE;
        }
        total += written;
    }
    return TRUE;
}

static BOOL read_exact_stdin(BYTE *bytes, DWORD length) {
    size_t read_count;
    int extra;
    if (_setmode(_fileno(stdin), _O_BINARY) == -1) {
        return FALSE;
    }
    read_count = fread(bytes, 1U, (size_t)length, stdin);
    extra = fgetc(stdin);
    return read_count == (size_t)length && extra == EOF && !ferror(stdin);
}

static BOOL emit_attestation(const struct root_attestation *attestation) {
    char root_id[FILE_ID_HEX_CHARS + 1U];
    char owner_digest[SHA256_HEX_CHARS + 1U];
    char dacl_digest[SHA256_HEX_CHARS + 1U];
    char inventory_digest[SHA256_HEX_CHARS + 1U];
    int written;
    bytes_to_hex(
        attestation->identity.file_id.Identifier,
        sizeof(attestation->identity.file_id.Identifier),
        root_id,
        sizeof(root_id));
    bytes_to_hex(
        attestation->owner_sid_sha256,
        SHA256_BYTES,
        owner_digest,
        sizeof(owner_digest));
    bytes_to_hex(
        attestation->dacl_sha256,
        SHA256_BYTES,
        dacl_digest,
        sizeof(dacl_digest));
    bytes_to_hex(
        attestation->inventory.sha256,
        SHA256_BYTES,
        inventory_digest,
        sizeof(inventory_digest));
    written = printf(
        "CONTROLLED_ROOT_ATTESTATION=PASS volume_serial=%016llx root_file_id=%s "
        "owner_sid_sha256=%s dacl_sha256=%s ace_count=3 inventory_sha256=%s "
        "inventory_count=%llu inventory_bytes=%llu retention_marker=present "
        "retention_expires_unix_seconds=%llu filesystem=NTFS drive_type=fixed "
        "protected_dacl=true reparse_count=0\n",
        (unsigned long long)attestation->identity.volume_serial,
        root_id,
        owner_digest,
        dacl_digest,
        inventory_digest,
        (unsigned long long)attestation->inventory.count,
        (unsigned long long)attestation->inventory.bytes,
        (unsigned long long)attestation->retention_expires_unix_seconds);
    return written > 0 && fflush(stdout) == 0;
}

static BOOL emit_mutation_receipt(
    const char *marker,
    const char *operation,
    const struct root_attestation *attestation,
    const struct file_identity *file_identity,
    const BYTE content_digest[SHA256_BYTES],
    uint64_t size,
    const BYTE leaf_digest[SHA256_BYTES]) {
    char root_id[FILE_ID_HEX_CHARS + 1U];
    char file_id[FILE_ID_HEX_CHARS + 1U];
    char content[SHA256_HEX_CHARS + 1U];
    char leaf[SHA256_HEX_CHARS + 1U];
    int written;
    bytes_to_hex(
        attestation->identity.file_id.Identifier,
        sizeof(attestation->identity.file_id.Identifier),
        root_id,
        sizeof(root_id));
    bytes_to_hex(
        file_identity->file_id.Identifier,
        sizeof(file_identity->file_id.Identifier),
        file_id,
        sizeof(file_id));
    bytes_to_hex(content_digest, SHA256_BYTES, content, sizeof(content));
    bytes_to_hex(leaf_digest, SHA256_BYTES, leaf, sizeof(leaf));
    written = printf(
        "%s volume_serial=%016llx root_file_id=%s file_id=%s content_sha256=%s "
        "size_bytes=%llu relative_name_sha256=%s hard_link_count=1 operation=%s\n",
        marker,
        (unsigned long long)attestation->identity.volume_serial,
        root_id,
        file_id,
        content,
        (unsigned long long)size,
        leaf,
        operation);
    return written > 0 && fflush(stdout) == 0;
}

static int run_attest(const wchar_t *root_path) {
    struct root_attestation attestation;
    int result = attest_root(root_path, FALSE, &attestation);
    if (result == ATTESTOR_OK && !emit_attestation(&attestation)) {
        result = ATTESTOR_OUTPUT;
    }
    close_attestation(&attestation);
    return result;
}

static int run_create(
    const wchar_t *root_path,
    const wchar_t *leaf,
    const wchar_t *expected_digest_text,
    const wchar_t *expected_size_text) {
    struct root_attestation attestation;
    struct file_identity created_identity;
    BYTE expected_digest[SHA256_BYTES];
    BYTE actual_digest[SHA256_BYTES];
    BYTE leaf_digest[SHA256_BYTES];
    BYTE *payload = NULL;
    uint64_t expected_size = 0ULL;
    wchar_t target_path[MAX_PATH_CHARS];
    HANDLE created_handle = INVALID_HANDLE_VALUE;
    BY_HANDLE_FILE_INFORMATION basic;
    BOOL delete_on_failure = FALSE;
    int result = ATTESTOR_INPUT;

    ZeroMemory(&attestation, sizeof(attestation));
    attestation.handle = INVALID_HANDLE_VALUE;
    if (!valid_leaf_name(leaf) ||
        !parse_lower_hex(
            expected_digest_text,
            expected_digest,
            sizeof(expected_digest)) ||
        !parse_u64(expected_size_text, MAX_CREATE_BYTES, &expected_size) ||
        !hash_leaf_name(leaf, leaf_digest)) {
        goto cleanup;
    }
    result = attest_root(root_path, FALSE, &attestation);
    if (result != ATTESTOR_OK) {
        goto cleanup;
    }
    payload = (BYTE *)HeapAlloc(
        GetProcessHeap(),
        HEAP_ZERO_MEMORY,
        (SIZE_T)expected_size);
    if (payload == NULL ||
        !read_exact_stdin(payload, (DWORD)expected_size) ||
        !sha256_buffer(payload, (size_t)expected_size, actual_digest) ||
        memcmp(actual_digest, expected_digest, SHA256_BYTES) != 0) {
        result = ATTESTOR_INPUT;
        goto cleanup;
    }
    if (!append_path(attestation.path, leaf, target_path) ||
        !root_identity_still_matches(&attestation)) {
        result = ATTESTOR_REPLACED;
        goto cleanup;
    }
    created_handle = CreateFileW(
        target_path,
        GENERIC_READ | GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL |
            WRITE_DAC | WRITE_OWNER | DELETE,
        0UL,
        NULL,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
            FILE_FLAG_WRITE_THROUGH,
        NULL);
    if (created_handle == INVALID_HANDLE_VALUE) {
        result = ATTESTOR_CREATE;
        goto cleanup;
    }
    delete_on_failure = TRUE;
    if (!apply_exact_dacl(created_handle, FALSE) ||
        !write_all(created_handle, payload, (DWORD)expected_size) ||
        !FlushFileBuffers(created_handle) ||
        !handle_is_non_reparse(created_handle, FALSE) ||
        !GetFileInformationByHandle(created_handle, &basic) ||
        basic.nNumberOfLinks != 1UL || basic.nFileSizeHigh != 0UL ||
        basic.nFileSizeLow != (DWORD)expected_size ||
        !file_identity_from_handle(created_handle, &created_identity) ||
        created_identity.volume_serial != attestation.identity.volume_serial ||
        !hash_file_handle(created_handle, expected_size, actual_digest) ||
        memcmp(actual_digest, expected_digest, SHA256_BYTES) != 0 ||
        !root_identity_still_matches(&attestation)) {
        result = ATTESTOR_IDENTITY;
        goto cleanup;
    }
    if (!CloseHandle(created_handle)) {
        created_handle = INVALID_HANDLE_VALUE;
        result = ATTESTOR_CREATE;
        goto cleanup;
    }
    created_handle = INVALID_HANDLE_VALUE;
    delete_on_failure = FALSE;
    if (!emit_mutation_receipt(
            "CONTROLLED_ROOT_CREATE=PASS",
            "create-new-flushed",
            &attestation,
            &created_identity,
            actual_digest,
            expected_size,
            leaf_digest)) {
        result = ATTESTOR_OUTPUT;
        goto cleanup;
    }
    result = ATTESTOR_OK;

cleanup:
    if (created_handle != INVALID_HANDLE_VALUE) {
        if (delete_on_failure) {
            (void)mark_handle_for_delete(created_handle);
        }
        (void)CloseHandle(created_handle);
    }
    if (payload != NULL) {
        SecureZeroMemory(payload, (SIZE_T)expected_size);
        (void)HeapFree(GetProcessHeap(), 0UL, payload);
    }
    close_attestation(&attestation);
    return result;
}

static int run_delete(
    BOOL cleanup_due,
    const wchar_t *root_path,
    const wchar_t *leaf,
    const wchar_t *expected_volume_text,
    const wchar_t *expected_root_id_text,
    const wchar_t *expected_file_id_text,
    const wchar_t *expected_digest_text,
    const wchar_t *expected_size_text,
    const wchar_t *expected_retention_text) {
    struct root_attestation attestation;
    struct file_identity opened_identity;
    FILE_ID_128 expected_root_id;
    FILE_ID_128 expected_file_id;
    BYTE expected_digest[SHA256_BYTES];
    BYTE actual_digest[SHA256_BYTES];
    BYTE leaf_digest[SHA256_BYTES];
    uint64_t expected_volume = 0ULL;
    uint64_t expected_size = 0ULL;
    uint64_t expected_retention = 0ULL;
    uint64_t current_retention = 0ULL;
    wchar_t target_path[MAX_PATH_CHARS];
    HANDLE opened_handle = INVALID_HANDLE_VALUE;
    BY_HANDLE_FILE_INFORMATION basic;
    FILE_STANDARD_INFO standard;
    DWORD target_attributes;
    DWORD target_error;
    int result = ATTESTOR_INPUT;

    ZeroMemory(&attestation, sizeof(attestation));
    attestation.handle = INVALID_HANDLE_VALUE;
    ZeroMemory(&expected_root_id, sizeof(expected_root_id));
    ZeroMemory(&expected_file_id, sizeof(expected_file_id));
    if (!valid_leaf_name(leaf) ||
        !parse_volume_serial(expected_volume_text, &expected_volume) ||
        !parse_lower_hex(
            expected_root_id_text,
            expected_root_id.Identifier,
            sizeof(expected_root_id.Identifier)) ||
        !parse_lower_hex(
            expected_file_id_text,
            expected_file_id.Identifier,
            sizeof(expected_file_id.Identifier)) ||
        !parse_lower_hex(
            expected_digest_text,
            expected_digest,
            sizeof(expected_digest)) ||
        !parse_u64(expected_size_text, MAX_CREATE_BYTES, &expected_size) ||
        !parse_u64(expected_retention_text, UINT64_MAX, &expected_retention) ||
        !hash_leaf_name(leaf, leaf_digest)) {
        goto cleanup;
    }
    result = attest_root(root_path, cleanup_due, &attestation);
    if (result != ATTESTOR_OK) {
        goto cleanup;
    }
    if (attestation.identity.volume_serial != expected_volume ||
        !file_id_equal(&attestation.identity.file_id, &expected_root_id) ||
        attestation.retention_expires_unix_seconds != expected_retention ||
        (cleanup_due && expected_retention > current_unix_seconds()) ||
        !append_path(attestation.path, leaf, target_path) ||
        !root_identity_still_matches(&attestation)) {
        result = ATTESTOR_REPLACED;
        goto cleanup;
    }
    opened_handle = CreateFileW(
        target_path,
        GENERIC_READ | FILE_READ_ATTRIBUTES | DELETE,
        FILE_SHARE_READ,
        NULL,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
        NULL);
    if (opened_handle == INVALID_HANDLE_VALUE) {
        result = ATTESTOR_DELETE;
        goto cleanup;
    }
    if (!handle_is_non_reparse(opened_handle, FALSE) ||
        !GetFileInformationByHandle(opened_handle, &basic) ||
        basic.nNumberOfLinks != 1UL || basic.nFileSizeHigh != 0UL ||
        basic.nFileSizeLow != (DWORD)expected_size ||
        !file_identity_from_handle(opened_handle, &opened_identity) ||
        opened_identity.volume_serial != expected_volume ||
        !file_id_equal(&opened_identity.file_id, &expected_file_id) ||
        !hash_file_handle(opened_handle, expected_size, actual_digest) ||
        memcmp(actual_digest, expected_digest, SHA256_BYTES) != 0 ||
        !root_identity_still_matches(&attestation) ||
        !read_retention_marker(
            attestation.path,
            expected_volume,
            cleanup_due,
            &current_retention) ||
        current_retention != expected_retention ||
        (cleanup_due && expected_retention > current_unix_seconds())) {
        result = ATTESTOR_REPLACED;
        goto cleanup;
    }
    if (!mark_handle_for_delete(opened_handle) ||
        !GetFileInformationByHandleEx(
            opened_handle,
            FileStandardInfo,
            &standard,
            (DWORD)sizeof(standard)) ||
        !standard.DeletePending) {
        result = ATTESTOR_DELETE;
        goto cleanup;
    }
    if (!CloseHandle(opened_handle)) {
        opened_handle = INVALID_HANDLE_VALUE;
        result = ATTESTOR_DELETE;
        goto cleanup;
    }
    opened_handle = INVALID_HANDLE_VALUE;
    target_attributes = GetFileAttributesW(target_path);
    target_error = target_attributes == INVALID_FILE_ATTRIBUTES
        ? GetLastError()
        : ERROR_SUCCESS;
    if (target_attributes != INVALID_FILE_ATTRIBUTES ||
        (target_error != ERROR_FILE_NOT_FOUND &&
            target_error != ERROR_PATH_NOT_FOUND)) {
        result = ATTESTOR_DELETE;
        goto cleanup;
    }
    if (!emit_mutation_receipt(
            "CONTROLLED_ROOT_DELETE=PASS",
            cleanup_due
                ? "handle-disposition-cleanup-delete"
                : "handle-disposition-probe-delete",
            &attestation,
            &opened_identity,
            actual_digest,
            expected_size,
            leaf_digest)) {
        result = ATTESTOR_OUTPUT;
        goto cleanup;
    }
    result = ATTESTOR_OK;

cleanup:
    if (opened_handle != INVALID_HANDLE_VALUE) {
        (void)CloseHandle(opened_handle);
    }
    close_attestation(&attestation);
    return result;
}

int wmain(int argc, wchar_t **argv) {
    if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
        return ATTESTOR_OUTPUT;
    }
    if (argc == 3 && wcscmp(argv[1], L"attest") == 0) {
        return run_attest(argv[2]);
    }
    if (argc == 6 && wcscmp(argv[1], L"create") == 0) {
        return run_create(argv[2], argv[3], argv[4], argv[5]);
    }
    if (argc == 10 &&
        (wcscmp(argv[1], L"probe-delete") == 0 ||
            wcscmp(argv[1], L"cleanup-delete") == 0)) {
        return run_delete(
            wcscmp(argv[1], L"cleanup-delete") == 0,
            argv[2],
            argv[3],
            argv[4],
            argv[5],
            argv[6],
            argv[7],
            argv[8],
            argv[9]);
    }
    return ATTESTOR_USAGE;
}
