#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdint.h>
#include <stdio.h>
#include <wchar.h>

/*
 * Test-only Windows process-boundary fixture for WP-0.4.3h.
 *
 * Stable exit codes (stdout and stderr are intentionally unused):
 *   0  observed abort-lane child exit and persisted its actual DWORD
 *   64 invalid command line
 *   65 fault-host identity is not the exact absolute regular-file target
 *   66 child command line exceeds the CreateProcessW bound
 *   67 CreateJobObjectW failed
 *   68 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE configuration failed
 *   69 CreateProcessW failed
 *   70 AssignProcessToJobObject failed (there is deliberately no fallback)
 *   71 ResumeThread failed
 *   72 launcher marker CREATE_NEW/write/flush failed
 *   73 child wait failed or reached the broker-owned hard deadline
 *   74 GetExitCodeProcess failed
 *   75 abort result marker CREATE_NEW/write/flush failed
 *   76 the hang-lane child exited instead of remaining supervised
 *   77 representative-AV marker CREATE_NEW/write/flush failed
 *   78 the injected representative access violation unexpectedly returned
 *   79 standard-stream forwarding could not be established or restored
 *   80 supervised child termination could not be confirmed within the bound
 */

enum fixture_exit_code {
    FIXTURE_OK = 0,
    FIXTURE_USAGE = 64,
    FIXTURE_HOST_IDENTITY = 65,
    FIXTURE_COMMAND_LINE = 66,
    FIXTURE_JOB_CREATE = 67,
    FIXTURE_JOB_CONFIGURE = 68,
    FIXTURE_PROCESS_CREATE = 69,
    FIXTURE_JOB_ASSIGN = 70,
    FIXTURE_THREAD_RESUME = 71,
    FIXTURE_LAUNCHER_MARKER = 72,
    FIXTURE_PROCESS_WAIT = 73,
    FIXTURE_PROCESS_EXIT_QUERY = 74,
    FIXTURE_RESULT_MARKER = 75,
    FIXTURE_HANG_CHILD_EXITED = 76,
    FIXTURE_REPRESENTATIVE_MARKER = 77,
    FIXTURE_REPRESENTATIVE_RETURNED = 78,
    FIXTURE_STANDARD_HANDLES = 79,
    FIXTURE_TERMINATION_CONFIRM = 80
};

enum marker_write_result {
    MARKER_WRITE_OK = 0,
    MARKER_WRITE_CREATE_FAILED = 1,
    MARKER_WRITE_CONTENT_FAILED = 2
};

struct standard_handle_forwarding {
    HANDLE input;
    HANDLE output;
    HANDLE error;
    DWORD output_flags;
    DWORD error_flags;
    BOOL shared_output_error;
};

static const wchar_t EXPECTED_FAULT_HOST_NAME[] =
    L"meetingrelay-sherpa-candidate-fault-host.exe";
static const wchar_t ABORT_MODE[] = L"abort-after-prepare";
static const wchar_t HANG_MODE[] = L"hang-after-inference";
static const DWORD ABORT_CHILD_WAIT_MS = 125000UL;
static const DWORD HANG_CHILD_WAIT_MS = 125000UL;
static const DWORD REPRESENTATIVE_AV_DWORD = 0xC0000005UL;

static enum marker_write_result write_create_new_marker(
    const wchar_t *path,
    const char *content,
    size_t content_length) {
    HANDLE file;
    DWORD bytes_written = 0UL;
    BOOL write_ok;
    BOOL flush_ok;
    BOOL close_ok;

    if (path == NULL || path[0] == L'\0' || content == NULL ||
        content_length > (size_t)MAXDWORD) {
        return MARKER_WRITE_CONTENT_FAILED;
    }

    file = CreateFileW(
        path,
        GENERIC_WRITE,
        0UL,
        NULL,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
        NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return MARKER_WRITE_CREATE_FAILED;
    }

    write_ok = WriteFile(
        file,
        content,
        (DWORD)content_length,
        &bytes_written,
        NULL);
    flush_ok = write_ok && bytes_written == (DWORD)content_length &&
        FlushFileBuffers(file);
    close_ok = CloseHandle(file);
    if (!write_ok || bytes_written != (DWORD)content_length || !flush_ok ||
        !close_ok) {
        (void)DeleteFileW(path);
        return MARKER_WRITE_CONTENT_FAILED;
    }
    return MARKER_WRITE_OK;
}

static BOOL append_character(
    wchar_t *buffer,
    size_t capacity,
    size_t *length,
    wchar_t value) {
    if (buffer == NULL || length == NULL || *length + 1U >= capacity) {
        return FALSE;
    }
    buffer[*length] = value;
    *length += 1U;
    buffer[*length] = L'\0';
    return TRUE;
}

/* Quote one argv element according to the CommandLineToArgvW backslash rules. */
static BOOL append_quoted_argument(
    wchar_t *buffer,
    size_t capacity,
    size_t *length,
    const wchar_t *argument) {
    const wchar_t *cursor;
    size_t backslashes = 0U;
    size_t index;

    if (argument == NULL || !append_character(buffer, capacity, length, L'"')) {
        return FALSE;
    }
    for (cursor = argument; *cursor != L'\0'; ++cursor) {
        if (*cursor == L'\\') {
            backslashes += 1U;
            continue;
        }
        if (*cursor == L'"') {
            for (index = 0U; index < backslashes * 2U + 1U; ++index) {
                if (!append_character(buffer, capacity, length, L'\\')) {
                    return FALSE;
                }
            }
            backslashes = 0U;
            if (!append_character(buffer, capacity, length, L'"')) {
                return FALSE;
            }
            continue;
        }
        for (index = 0U; index < backslashes; ++index) {
            if (!append_character(buffer, capacity, length, L'\\')) {
                return FALSE;
            }
        }
        backslashes = 0U;
        if (!append_character(buffer, capacity, length, *cursor)) {
            return FALSE;
        }
    }
    for (index = 0U; index < backslashes * 2U; ++index) {
        if (!append_character(buffer, capacity, length, L'\\')) {
            return FALSE;
        }
    }
    return append_character(buffer, capacity, length, L'"');
}

static BOOL build_fault_host_command_line(
    wchar_t *buffer,
    size_t capacity,
    wchar_t *argv[]) {
    size_t length = 0U;
    int child_index;
    const wchar_t *argument;

    if (buffer == NULL || capacity == 0U || argv == NULL) {
        return FALSE;
    }
    buffer[0] = L'\0';
    for (child_index = 0; child_index < 10; ++child_index) {
        if (child_index > 0 &&
            !append_character(buffer, capacity, &length, L' ')) {
            return FALSE;
        }
        if (child_index == 0) {
            argument = argv[5];
        } else if (child_index == 1) {
            argument = argv[2];
        } else {
            argument = argv[child_index + 4];
        }
        if (!append_quoted_argument(buffer, capacity, &length, argument)) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOL is_exact_fault_host_path(const wchar_t *path) {
    wchar_t full_path[32768];
    DWORD full_length;
    DWORD attributes;
    const wchar_t *file_name;
    const wchar_t *alternate_separator;

    if (path == NULL || path[0] == L'\0') {
        return FALSE;
    }
    full_length = GetFullPathNameW(
        path,
        (DWORD)(sizeof(full_path) / sizeof(full_path[0])),
        full_path,
        NULL);
    if (full_length == 0UL ||
        full_length >= (DWORD)(sizeof(full_path) / sizeof(full_path[0])) ||
        _wcsicmp(full_path, path) != 0) {
        return FALSE;
    }

    attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0UL ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0UL) {
        return FALSE;
    }

    file_name = wcsrchr(path, L'\\');
    alternate_separator = wcsrchr(path, L'/');
    if (alternate_separator != NULL &&
        (file_name == NULL || alternate_separator > file_name)) {
        file_name = alternate_separator;
    }
    file_name = file_name == NULL ? path : file_name + 1;
    return _wcsicmp(file_name, EXPECTED_FAULT_HOST_NAME) == 0;
}

static BOOL restore_standard_handle_forwarding(
    struct standard_handle_forwarding *forwarding) {
    BOOL output_ok = TRUE;
    BOOL error_ok = TRUE;
    BOOL input_ok = TRUE;

    if (forwarding == NULL) {
        return FALSE;
    }
    if (forwarding->output != NULL &&
        forwarding->output != INVALID_HANDLE_VALUE) {
        output_ok = SetHandleInformation(
            forwarding->output,
            HANDLE_FLAG_INHERIT,
            forwarding->output_flags & HANDLE_FLAG_INHERIT);
    }
    if (!forwarding->shared_output_error && forwarding->error != NULL &&
        forwarding->error != INVALID_HANDLE_VALUE) {
        error_ok = SetHandleInformation(
            forwarding->error,
            HANDLE_FLAG_INHERIT,
            forwarding->error_flags & HANDLE_FLAG_INHERIT);
    }
    if (forwarding->input != NULL &&
        forwarding->input != INVALID_HANDLE_VALUE) {
        input_ok = CloseHandle(forwarding->input);
        forwarding->input = NULL;
    }
    return output_ok && error_ok && input_ok;
}

static BOOL prepare_standard_handle_forwarding(
    struct standard_handle_forwarding *forwarding,
    STARTUPINFOW *startup) {
    SECURITY_ATTRIBUTES security = {0};
    DWORD input_flags = 0UL;

    if (forwarding == NULL || startup == NULL) {
        return FALSE;
    }
    ZeroMemory(forwarding, sizeof(*forwarding));
    forwarding->output = GetStdHandle(STD_OUTPUT_HANDLE);
    forwarding->error = GetStdHandle(STD_ERROR_HANDLE);
    if (forwarding->output == NULL ||
        forwarding->output == INVALID_HANDLE_VALUE ||
        forwarding->error == NULL ||
        forwarding->error == INVALID_HANDLE_VALUE ||
        !GetHandleInformation(
            forwarding->output,
            &forwarding->output_flags)) {
        return FALSE;
    }
    forwarding->shared_output_error =
        forwarding->output == forwarding->error;
    if (forwarding->shared_output_error) {
        forwarding->error_flags = forwarding->output_flags;
    } else if (!GetHandleInformation(
                   forwarding->error,
                   &forwarding->error_flags)) {
        return FALSE;
    }
    if (!SetHandleInformation(
            forwarding->output,
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT)) {
        return FALSE;
    }
    if (!forwarding->shared_output_error &&
        !SetHandleInformation(
            forwarding->error,
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT)) {
        (void)SetHandleInformation(
            forwarding->output,
            HANDLE_FLAG_INHERIT,
            forwarding->output_flags & HANDLE_FLAG_INHERIT);
        return FALSE;
    }

    security.nLength = (DWORD)sizeof(security);
    security.bInheritHandle = TRUE;
    forwarding->input = CreateFileW(
        L"NUL",
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (forwarding->input == INVALID_HANDLE_VALUE ||
        !GetHandleInformation(forwarding->input, &input_flags) ||
        (input_flags & HANDLE_FLAG_INHERIT) == 0UL) {
        if (forwarding->input == INVALID_HANDLE_VALUE) {
            forwarding->input = NULL;
        }
        (void)restore_standard_handle_forwarding(forwarding);
        return FALSE;
    }

    startup->dwFlags |= STARTF_USESTDHANDLES;
    startup->hStdInput = forwarding->input;
    startup->hStdOutput = forwarding->output;
    startup->hStdError = forwarding->error;
    return TRUE;
}

static BOOL terminate_supervised_child(HANDLE job, HANDLE child, DWORD code) {
    BOOL terminate_ok = FALSE;
    DWORD wait_result;

    if (job != NULL) {
        terminate_ok = TerminateJobObject(job, code);
    } else if (child != NULL) {
        terminate_ok = TerminateProcess(child, code);
    }
    if (!terminate_ok || child == NULL) {
        return FALSE;
    }
    wait_result = WaitForSingleObject(child, 5000UL);
    return wait_result == WAIT_OBJECT_0;
}

static int supervise_rust_fault_host(wchar_t *argv[]) {
    wchar_t command_line[32768];
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    struct standard_handle_forwarding forwarding = {0};
    HANDLE job = NULL;
    DWORD wait_result;
    DWORD child_exit_code = 0UL;
    DWORD resume_result;
    char launcher_marker[512];
    char result_marker[384];
    int launcher_length;
    int result_length;
    int outcome = FIXTURE_OK;
    BOOL abort_lane = _wcsicmp(argv[2], ABORT_MODE) == 0;

    if (!is_exact_fault_host_path(argv[5])) {
        return FIXTURE_HOST_IDENTITY;
    }
    if (!build_fault_host_command_line(
            command_line,
            sizeof(command_line) / sizeof(command_line[0]),
            argv)) {
        return FIXTURE_COMMAND_LINE;
    }

    job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) {
        return FIXTURE_JOB_CREATE;
    }
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits,
            (DWORD)sizeof(limits))) {
        CloseHandle(job);
        return FIXTURE_JOB_CONFIGURE;
    }

    startup.cb = (DWORD)sizeof(startup);
    if (!prepare_standard_handle_forwarding(&forwarding, &startup)) {
        CloseHandle(job);
        return FIXTURE_STANDARD_HANDLES;
    }
    if (!CreateProcessW(
            argv[5],
            command_line,
            NULL,
            NULL,
            TRUE,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            NULL,
            NULL,
            &startup,
            &process)) {
        BOOL restore_ok = restore_standard_handle_forwarding(&forwarding);
        CloseHandle(job);
        return restore_ok ? FIXTURE_PROCESS_CREATE : FIXTURE_STANDARD_HANDLES;
    }
    if (!restore_standard_handle_forwarding(&forwarding)) {
        BOOL termination_confirmed = terminate_supervised_child(
            NULL,
            process.hProcess,
            FIXTURE_STANDARD_HANDLES);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return termination_confirmed ?
            FIXTURE_STANDARD_HANDLES : FIXTURE_TERMINATION_CONFIRM;
    }
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        BOOL termination_confirmed = terminate_supervised_child(
            NULL,
            process.hProcess,
            FIXTURE_JOB_ASSIGN);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return termination_confirmed ?
            FIXTURE_JOB_ASSIGN : FIXTURE_TERMINATION_CONFIRM;
    }

    resume_result = ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    process.hThread = NULL;
    if (resume_result == (DWORD)-1) {
        BOOL termination_confirmed = terminate_supervised_child(
            job,
            process.hProcess,
            FIXTURE_THREAD_RESUME);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return termination_confirmed ?
            FIXTURE_THREAD_RESUME : FIXTURE_TERMINATION_CONFIRM;
    }

    launcher_length = sprintf_s(
        launcher_marker,
        sizeof(launcher_marker),
        "{\"broker_pid\":%lu,\"checkpoint\":\"child-resumed-under-kill-on-close-job\","
        "\"child_pid\":%lu,\"kind\":\"meetingrelay-native-fatal-launcher-marker-v1\","
        "\"mode\":\"%ls\"}\n",
        GetCurrentProcessId(),
        process.dwProcessId,
        argv[2]);
    if (launcher_length <= 0 ||
        write_create_new_marker(
            argv[3],
            launcher_marker,
            (size_t)launcher_length) != MARKER_WRITE_OK) {
        BOOL termination_confirmed = terminate_supervised_child(
            job,
            process.hProcess,
            FIXTURE_LAUNCHER_MARKER);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return termination_confirmed ?
            FIXTURE_LAUNCHER_MARKER : FIXTURE_TERMINATION_CONFIRM;
    }

    wait_result = WaitForSingleObject(
        process.hProcess,
        abort_lane ? ABORT_CHILD_WAIT_MS : HANG_CHILD_WAIT_MS);
    if (wait_result == WAIT_TIMEOUT) {
        outcome = terminate_supervised_child(
            job,
            process.hProcess,
            FIXTURE_PROCESS_WAIT) ?
            FIXTURE_PROCESS_WAIT : FIXTURE_TERMINATION_CONFIRM;
    } else if (wait_result != WAIT_OBJECT_0) {
        outcome = terminate_supervised_child(
            job,
            process.hProcess,
            FIXTURE_PROCESS_WAIT) ?
            FIXTURE_PROCESS_WAIT : FIXTURE_TERMINATION_CONFIRM;
    } else if (!GetExitCodeProcess(process.hProcess, &child_exit_code)) {
        outcome = FIXTURE_PROCESS_EXIT_QUERY;
    } else if (!abort_lane) {
        outcome = FIXTURE_HANG_CHILD_EXITED;
    } else {
        result_length = sprintf_s(
            result_marker,
            sizeof(result_marker),
            "{\"checkpoint\":\"child-exit-observed\",\"child_exit_code_dword\":%lu,"
            "\"kind\":\"meetingrelay-native-fatal-result-marker-v1\","
            "\"mode\":\"abort-after-prepare\"}\n",
            child_exit_code);
        if (result_length <= 0 ||
            write_create_new_marker(
                argv[4],
                result_marker,
                (size_t)result_length) != MARKER_WRITE_OK) {
            outcome = FIXTURE_RESULT_MARKER;
        }
    }

    CloseHandle(process.hProcess);
    CloseHandle(job);
    return outcome;
}

static int run_representative_access_violation(const wchar_t *marker_path) {
    char marker[512];
    int marker_length;
    volatile uintptr_t invalid_address = (uintptr_t)1U;
    volatile unsigned char *invalid_pointer;

    marker_length = sprintf_s(
        marker,
        sizeof(marker),
        "{\"checkpoint\":\"before-injected-access-violation\","
        "\"expected_exit_code_dword\":%lu,"
        "\"fault_origin\":\"injected-representative-boundary\","
        "\"kind\":\"meetingrelay-native-fatal-representative-av-marker-v1\","
        "\"sherpa_defect\":false}\n",
        REPRESENTATIVE_AV_DWORD);
    if (marker_length <= 0 ||
        write_create_new_marker(
            marker_path,
            marker,
            (size_t)marker_length) != MARKER_WRITE_OK) {
        return FIXTURE_REPRESENTATIVE_MARKER;
    }

    /* Deliberately injected boundary proof, never evidence of a Sherpa defect. */
    invalid_pointer = (volatile unsigned char *)invalid_address;
    *invalid_pointer = 0xA5U;
    return FIXTURE_REPRESENTATIVE_RETURNED;
}

int wmain(int argc, wchar_t *argv[]) {
    (void)SetErrorMode(
        SEM_FAILCRITICALERRORS |
        SEM_NOGPFAULTERRORBOX |
        SEM_NOOPENFILEERRORBOX);

    if (argc >= 2 && wcscmp(argv[1], L"representative-av") == 0) {
        if (argc != 3 || argv[2][0] == L'\0' || wcscmp(argv[2], L"-") == 0) {
            return FIXTURE_USAGE;
        }
        return run_representative_access_violation(argv[2]);
    }

    if (argc >= 2 && wcscmp(argv[1], L"supervise-rust") == 0) {
        BOOL abort_lane;
        BOOL hang_lane;
        if (argc != 14) {
            return FIXTURE_USAGE;
        }
        abort_lane = wcscmp(argv[2], ABORT_MODE) == 0;
        hang_lane = wcscmp(argv[2], HANG_MODE) == 0;
        if ((!abort_lane && !hang_lane) || argv[3][0] == L'\0' ||
            argv[5][0] == L'\0' ||
            (abort_lane && (argv[4][0] == L'\0' || wcscmp(argv[4], L"-") == 0)) ||
            (hang_lane && wcscmp(argv[4], L"-") != 0)) {
            return FIXTURE_USAGE;
        }
        return supervise_rust_fault_host(argv);
    }

    return FIXTURE_USAGE;
}
