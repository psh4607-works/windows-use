# Cross-platform orchestration. Actions own all Windows effects; exceptions never enter reports.
function Assert-ReleaseCheckpoint($Resume, [string]$Evidence) {
    $completed=@('preflight','install-previous','verify-previous','smoke-previous','fixture-previous','prepare-update','update','verify-candidate','smoke-candidate','fixture-candidate','checkpoint')
    if (!$Resume -or $Resume.schemaVersion -ne 1 -or $Resume.status -ne 'checkpoint' -or $Resume.evidence -ne $Evidence -or
        @($Resume.steps | Where-Object { ($_.id -ne 'checkpoint' -and $_.status -ne 'passed') -or
            ($_.id -eq 'checkpoint' -and $_.status -ne 'unverified') -or $_.code -cnotmatch '^[a-z_]+$' }).Count -ne 0 -or
        (($Resume.steps.id -join ',') -ne ($completed -join ','))) { throw 'invalid_checkpoint' }
}

function Invoke-ReleasePlan {
    param([hashtable]$Context, [hashtable]$Actions,
        [ValidateSet('fixture','windows')][string]$Evidence = 'windows',
        [switch]$PauseForRelogin, $Resume)
    $phases = @('preflight','install-previous','verify-previous','smoke-previous','fixture-previous','prepare-update','update','verify-candidate','smoke-candidate','fixture-candidate')
    $steps = [Collections.Generic.List[object]]::new()
    if ($Resume) {
        Assert-ReleaseCheckpoint $Resume $Evidence
        foreach ($step in $Resume.steps) { $steps.Add([ordered]@{ id=$step.id; status=$step.status; code=$step.code }) }
        $phases = @('relogin')
    }
    if (!$PauseForRelogin -or $Resume) { $phases += @('uninstall','verify-uninstall') }
    else { $phases += 'checkpoint' }
    $retained = $false
    $failed = $false
    try {
        foreach ($phase in $phases) {
            if ($failed) {
                $steps.Add([ordered]@{ id=$phase; status='skipped'; code='upstream_failed' })
                continue
            }
            try {
                $detail = & $Actions[$phase] $Context $phase
                if ($detail.status -notin @('passed','skipped','unverified')) { throw 'invalid_step_result' }
                $steps.Add([ordered]@{ id=$phase; status=$detail.status; code=$detail.code })
                if ($phase -eq 'checkpoint') { $retained = $true }
            } catch {
                $code='step_failed'
                if ($_.Exception.Message -cin @('package_owner_missing','user_data_not_preserved','uninstall_removed_user_data',
                    'fixture_input_not_verified','fixture_close_failed','fixture_shutdown_failed','native_exit_nonzero','native_timeout','native_output_timeout')) {
                    $code=$_.Exception.Message
                }
                $step=[ordered]@{ id=$phase; status='failed'; code=$code }
                $secondary=@($_.Exception.Data['releaseSecondaryCodes'] | Where-Object { $_ -cin @('fixture_close_failed','fixture_shutdown_failed') })
                if ($secondary.Count) { $step.secondaryCodes=$secondary }
                $steps.Add($step)
                $failed = $true
            }
        }
    } finally {
        if (!$retained) {
            try {
                $detail = & $Actions['cleanup'] $Context 'cleanup'
                if ($detail.status -notin @('passed','skipped')) { throw 'invalid_cleanup_result' }
                $steps.Add([ordered]@{ id='cleanup'; status=$detail.status; code=$detail.code })
            } catch {
                $steps.Add([ordered]@{ id='cleanup'; status='failed'; code='ownership_or_cleanup_failed' })
                $failed = $true
            }
        }
    }
    $coverage = @(
        @{ id='interactive-wizard'; status='unverified'; code='manual_validation_required' },
        @{ id='clean-vm-without-node'; status='unverified'; code='environment_provenance_required' }
    )
    if (!$Resume) { $coverage += @{ id='actual-relogin'; status='unverified'; code='explicit_checkpoint_opt_in' } }
    $requiredPassed = !$failed -and !$retained -and @($steps | Where-Object { $_.id -ne 'checkpoint' -and $_.status -ne 'passed' }).Count -eq 0
    $status = if ($failed) { 'failed' } elseif ($retained) { 'checkpoint' } else { 'incomplete' }
    $exitCode = if ($failed) { 1 } else { 2 }
    return [ordered]@{ schemaVersion=1; evidence=$Evidence; status=$status; requiredPassed=$requiredPassed;
        exitCode=$exitCode; steps=@($steps.ToArray()); coverage=$coverage }
}
