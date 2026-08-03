param(
    [switch]$CheckOnly,
    [switch]$InstallPython
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BaseErrors = 0
$OptionalWarnings = 0

function Write-Ok([string]$Message) {
    Write-Host "[ OK ] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    $script:OptionalWarnings++
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
    $script:BaseErrors++
    Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Find-Command([string]$Name) {
    return Get-Command $Name -ErrorAction SilentlyContinue
}

function Resolve-PythonCommand {
    if ($env:PYTHON_BIN -and (Test-Path $env:PYTHON_BIN)) {
        return @{ Exe = $env:PYTHON_BIN; Prefix = @() }
    }

    $python = Find-Command "python"
    if ($python) {
        return @{ Exe = $python.Source; Prefix = @() }
    }

    $py = Find-Command "py"
    if ($py) {
        return @{ Exe = $py.Source; Prefix = @("-3") }
    }

    return $null
}

function Invoke-Python($PythonCommand, [string[]]$Arguments) {
    $allArguments = @($PythonCommand.Prefix) + $Arguments
    $pythonExecutable = $PythonCommand.Exe
    & $pythonExecutable @allArguments
}

function Test-OptionalCommand([string]$Name, [string]$Purpose) {
    $command = Find-Command $Name
    if ($command) {
        Write-Ok "${Purpose}: $($command.Source)"
    } else {
        Write-Warn "${Purpose} not found (${Name})."
    }
}

function Test-NerfstudioCommand([string]$Name, [string]$Purpose, $PythonCommand) {
    $command = Find-Command $Name
    if ($command) {
        Write-Ok "${Purpose}: $($command.Source)"
        return
    }

    if ($PythonCommand) {
        $pythonDirectory = Split-Path $PythonCommand.Exe -Parent
        foreach ($candidateName in @($Name, "${Name}.exe")) {
            $candidate = Join-Path $pythonDirectory $candidateName
            if (Test-Path $candidate) {
                Write-Ok "${Purpose}: ${candidate}"
                return
            }
        }
    }

    Write-Warn "${Purpose} not found (${Name})."
}

Write-Host ""
Write-Host "Splat to Sculpt Windows setup check"
Write-Host "Project: $ProjectRoot"
Write-Host ""

$node = Find-Command "node"
if ($node) {
    $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
    if ($nodeMajor -ge 20) {
        Write-Ok "Node.js $(& node --version)"
    } else {
        Write-Fail "Node.js 20 or newer is required; found $(& node --version)."
    }
} else {
    Write-Fail "Node.js is not installed. Install Node.js 20 or newer."
}

$pnpm = Find-Command "pnpm"
if ($pnpm) {
    Write-Ok "pnpm $(& pnpm --version)"
} else {
    Write-Fail "pnpm is not installed. Run: corepack enable; corepack prepare pnpm@9 --activate"
}

$bash = Find-Command "bash"
if ($bash) {
    Write-Ok "Bash for project build/start scripts: $($bash.Source)"
} else {
    Write-Fail "Bash was not found. Install Git for Windows, which includes Git Bash."
}

$pythonCommand = Resolve-PythonCommand
if ($pythonCommand) {
    $pythonVersion = (Invoke-Python $pythonCommand @("-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"))
    Write-Ok "Python ${pythonVersion}: $($pythonCommand.Exe)"

    $recommended = Invoke-Python $pythonCommand @("-c", "import sys; print('yes' if (3, 10) <= sys.version_info[:2] <= (3, 12) else 'no')")
    if ($recommended -ne "yes") {
        Write-Warn "Python 3.10-3.12 is recommended for Open3D and rembg compatibility."
    }

    if ($InstallPython) {
        Write-Host ""
        Write-Host "Installing Python processing dependencies..."
        Invoke-Python $pythonCommand @("-m", "pip", "install", "-Ur", (Join-Path $ProjectRoot "scripts/requirements-python.txt"))
        if ($LASTEXITCODE -ne 0) {
            throw "Python dependency installation failed with exit code $LASTEXITCODE"
        }
    }

    $importCheck = @'
modules = ["cv2", "numpy", "onnxruntime", "open3d", "pyrender", "rembg", "trimesh"]
missing = []
for module in modules:
    try:
        __import__(module)
    except Exception:
        missing.append(module)
print(", ".join(missing))
'@
    $missingModules = (Invoke-Python $pythonCommand @("-c", $importCheck))
    if (-not $missingModules) {
        Write-Ok "Core Python processing packages"
    } else {
        Write-Warn "Unavailable Python imports: ${missingModules}. Re-run with -InstallPython or repair that environment."
    }
} else {
    Write-Warn "Python 3 was not found. The basic web UI can run, but reconstruction scripts cannot."
}

Test-OptionalCommand "ffmpeg" "FFmpeg frame extraction"
Test-OptionalCommand "colmap" "COLMAP reconstruction"

$blender = Find-Command "blender"
if ($blender) {
    Write-Ok "Blender: $($blender.Source)"
} else {
    $blenderInstall = Get-ChildItem "C:\Program Files\Blender Foundation\Blender *\blender.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($blenderInstall) {
        Write-Ok "Blender: $($blenderInstall.FullName)"
    } else {
        Write-Warn "Blender was not found. Model Cleanup and Surface Processing will be unavailable."
    }
}

Test-NerfstudioCommand "ns-train" "Nerfstudio True training" $pythonCommand
Test-NerfstudioCommand "ns-export" "Nerfstudio export" $pythonCommand

$comfyUrl = $env:COMFYUI_BASE_URL
if (-not $comfyUrl) {
    $comfyUrl = "http://127.0.0.1:8000"
}
try {
    Invoke-RestMethod -Uri "$comfyUrl/system_stats" -Method Get -TimeoutSec 2 | Out-Null
    Write-Ok "ComfyUI connected: $comfyUrl"
} catch {
    Write-Warn "ComfyUI is not reachable at ${comfyUrl}; this is optional until video generation is used."
}

if (-not $CheckOnly) {
    if ($node -and $pnpm) {
        Write-Host ""
        Write-Host "Installing locked pnpm dependencies..."
        Push-Location $ProjectRoot
        try {
            & pnpm install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) {
                throw "pnpm install failed with exit code $LASTEXITCODE"
            }
            Write-Ok "Project JavaScript dependencies"
        } finally {
            Pop-Location
        }
    }
} elseif (Test-Path (Join-Path $ProjectRoot "node_modules")) {
    Write-Ok "node_modules is present"
} else {
    Write-Warn "node_modules is missing. Run this script without -CheckOnly to install it."
}

Write-Host ""
Write-Host "Setup summary"
if ($BaseErrors -eq 0) {
    Write-Ok "Basic web prerequisites are ready. Run: pnpm dev"
} else {
    Write-Host "[FAIL] $BaseErrors required prerequisite(s) need attention." -ForegroundColor Red
}
Write-Host "[INFO] $OptionalWarnings optional full-workflow item(s) need attention."
Write-Host "[INFO] Use PYTHON_BIN, NS_TRAIN_BIN, NS_EXPORT_BIN, and COMFYUI_BASE_URL to override detected tools."

if ($BaseErrors -ne 0) {
    exit 1
}
