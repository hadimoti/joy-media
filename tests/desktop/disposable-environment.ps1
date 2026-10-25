# Shared disposable-host gate for the destructive installer harnesses: windows-lifecycle.ps1 and the Windows Sandbox
# guest runner. The rules match tests/desktop/disposable-host.mjs, which the installer package check uses. A run
# proceeds only where the host is positively identified: a CI container runner, a Hyper-V disposable guest with the
# lifecycle marker, or a Windows Sandbox session. A Sandbox session needs five facts together: a virtual machine,
# the sandbox account and profile, a session file in the staging folder, and the same nonce from the launch. A probe
# that cannot answer refuses before anything is changed.

$script:SandboxSessionPurpose = 'joy-media-windows-sandbox'
$script:SandboxUser = 'WDAGUtilityAccount'

function Get-DisposableEnvironmentFacts {
    $manufacturer = $null
    $model = $null
    try {
        $system = Get-CimInstance -ClassName Win32_ComputerSystem
        $manufacturer = [string]$system.Manufacturer
        $model = [string]$system.Model
    } catch { }
    $marker = $null
    $markerPath = Join-Path $env:SystemDrive 'JoyMediaLifecycle\disposable-environment.json'
    try {
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json }
    } catch { $marker = $null }
    $session = $null
    $sessionPath = Join-Path $env:USERPROFILE 'Desktop\JOY-Staging\session.json'
    try {
        if (Test-Path -LiteralPath $sessionPath -PathType Leaf) { $session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json }
    } catch { $session = $null }
    return [pscustomobject]@{
        Hostname = (hostname).Trim().ToLowerInvariant()
        Manufacturer = $manufacturer
        Model = $model
        Marker = $marker
        UserName = [string]$env:USERNAME
        Profile = [string]$env:USERPROFILE
        SandboxSession = $session
    }
}

function Test-WindowsSandboxIdentity {
    param([AllowNull()]$Facts, [Parameter(Mandatory = $true)][hashtable]$Environment)
    if ($null -eq $Facts -or $null -eq $Facts.SandboxSession) { return $false }
    $nonce = [string]$Environment['JOY_MEDIA_SANDBOX_NONCE']
    return ([string]$Facts.Manufacturer -ceq 'Microsoft Corporation') -and
        ([string]$Facts.Model -ceq 'Virtual Machine') -and
        ([string]$Facts.UserName -ceq $script:SandboxUser) -and
        ([string]$Facts.Profile -imatch ('\\Users\\' + $script:SandboxUser + '$')) -and
        ([string]$Facts.SandboxSession.purpose -ceq $script:SandboxSessionPurpose) -and
        ($nonce -cmatch '^[0-9a-f]{32}$') -and
        ([string]$Facts.SandboxSession.nonce -ceq $nonce)
}

function Test-DisposableEnvironment {
    param(
        [AllowNull()]$Facts,
        [Parameter(Mandatory = $true)][hashtable]$Environment
    )
    if ($null -eq $Facts -or $null -eq $Facts.Hostname) {
        return [pscustomobject]@{ Allowed = $false; Environment = ''; Reasons = @('the environment probe did not answer') }
    }
    $containerId = [string]$Environment['JOY_MEDIA_WINDOWS_CONTAINER_ID']
    $containerIdentified = ([string]$Environment['GITHUB_ACTIONS'] -ceq 'true') -and
        ([string]$Environment['RUNNER_ENVIRONMENT'] -ceq 'self-hosted') -and
        ($containerId -cmatch '^[0-9a-f]{12,64}$') -and
        ([string]$Facts.Hostname -ceq $containerId)
    if ($containerIdentified) {
        return [pscustomobject]@{ Allowed = $true; Environment = 'ci-container'; Reasons = @() }
    }
    $hyperVIdentified = ([string]$Facts.Manufacturer -ceq 'Microsoft Corporation') -and
        ([string]$Facts.Model -ceq 'Virtual Machine') -and
        ($null -ne $Facts.Marker) -and
        ([string]$Facts.Marker.purpose -ceq 'joy-media-disposable-test-environment') -and
        ([string]$Facts.Marker.kind -ceq 'hyperv-vm')
    if ($hyperVIdentified) {
        return [pscustomobject]@{ Allowed = $true; Environment = 'hyperv-vm'; Reasons = @() }
    }
    if (Test-WindowsSandboxIdentity -Facts $Facts -Environment $Environment) {
        return [pscustomobject]@{ Allowed = $true; Environment = 'windows-sandbox'; Reasons = @() }
    }
    return [pscustomobject]@{ Allowed = $false; Environment = ''; Reasons = @('no CI container runner, Hyper-V disposable guest or Windows Sandbox session was positively identified') }
}

# Returns the identified environment name, or throws with the refusal prefix and the reasons.
function Assert-DisposableEnvironment([string]$Refusal) {
    $facts = $null
    try { $facts = Get-DisposableEnvironmentFacts } catch { $facts = $null }
    $verdict = Test-DisposableEnvironment -Facts $facts -Environment @{
        GITHUB_ACTIONS = $env:GITHUB_ACTIONS
        RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT
        JOY_MEDIA_WINDOWS_CONTAINER_ID = $env:JOY_MEDIA_WINDOWS_CONTAINER_ID
        JOY_MEDIA_SANDBOX_NONCE = $env:JOY_MEDIA_SANDBOX_NONCE
    }
    if (-not $verdict.Allowed) { throw ($Refusal + ': ' + ($verdict.Reasons -join '; ')) }
    return $verdict.Environment
}
