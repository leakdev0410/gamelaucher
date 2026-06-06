//go:build windows

// add-defender-exclusion: a standalone one-shot tool that adds a folder to the
// Windows Defender exclusion list. With no argument it adds the folder the exe
// itself sits in; otherwise it adds each path passed as an argument. It will
// re-launch itself elevated (UAC) when not already running as administrator.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	shell32          = syscall.NewLazyDLL("shell32.dll")
	procIsUserAdmin  = shell32.NewProc("IsUserAnAdmin")
	procShellExecute = shell32.NewProc("ShellExecuteW")

	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procSetConsoleOutputCP = kernel32.NewProc("SetConsoleOutputCP")
)

func init() {
	// Render UTF-8 (Vietnamese diacritics) correctly in the console.
	procSetConsoleOutputCP.Call(65001)
}

func isAdmin() bool {
	ret, _, _ := procIsUserAdmin.Call()
	return ret != 0
}

// relaunchElevated re-runs this exe with the "runas" verb so Windows shows a
// UAC prompt and starts an elevated copy with the same arguments.
func relaunchElevated() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	verbPtr, _ := syscall.UTF16PtrFromString("runas")
	exePtr, _ := syscall.UTF16PtrFromString(exe)
	argPtr, _ := syscall.UTF16PtrFromString(buildArgLine(os.Args[1:]))
	cwdPtr, _ := syscall.UTF16PtrFromString(filepath.Dir(exe))

	ret, _, callErr := procShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(verbPtr)),
		uintptr(unsafe.Pointer(exePtr)),
		uintptr(unsafe.Pointer(argPtr)),
		uintptr(unsafe.Pointer(cwdPtr)),
		uintptr(int32(1)), // SW_SHOWNORMAL
	)
	if ret <= 32 {
		return fmt.Errorf("ShellExecuteW failed (code %d): %v", ret, callErr)
	}
	return nil
}

func buildArgLine(args []string) string {
	parts := make([]string, 0, len(args))
	for _, a := range args {
		parts = append(parts, `"`+strings.ReplaceAll(a, `"`, `\"`)+`"`)
	}
	return strings.Join(parts, " ")
}

func targetPaths() ([]string, error) {
	var raw []string
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "-") {
			continue
		}
		raw = append(raw, a)
	}

	if len(raw) == 0 {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		raw = append(raw, filepath.Dir(exe))
	}

	paths := make([]string, 0, len(raw))
	for _, p := range raw {
		abs, err := filepath.Abs(p)
		if err != nil {
			abs = p
		}
		paths = append(paths, abs)
	}
	return paths, nil
}

func addExclusion(path string) error {
	escaped := strings.ReplaceAll(path, "'", "''")
	script := fmt.Sprintf("Add-MpPreference -ExclusionPath '%s' -ErrorAction Stop", escaped)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func currentExclusions() string {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-MpPreference).ExclusionPath")
	out, _ := cmd.CombinedOutput()
	return strings.TrimSpace(string(out))
}

func pause() {
	fmt.Print("\nNhấn Enter để thoát...")
	var s string
	fmt.Scanln(&s)
}

func main() {
	if !isAdmin() {
		fmt.Println("Cần quyền Administrator — đang yêu cầu nâng quyền (UAC)...")
		if err := relaunchElevated(); err != nil {
			fmt.Println("Lỗi nâng quyền:", err)
			pause()
			os.Exit(1)
		}
		return
	}

	paths, err := targetPaths()
	if err != nil {
		fmt.Println("Không xác định được thư mục:", err)
		pause()
		os.Exit(1)
	}

	exitCode := 0
	for _, p := range paths {
		fmt.Printf("Thêm ngoại lệ Windows Defender cho: %s\n", p)
		if err := addExclusion(p); err != nil {
			fmt.Printf("  THẤT BẠI: %v\n", err)
			exitCode = 1
		} else {
			fmt.Println("  OK")
		}
	}

	fmt.Println("\nDanh sách ngoại lệ hiện tại:")
	fmt.Println(currentExclusions())

	pause()
	os.Exit(exitCode)
}
