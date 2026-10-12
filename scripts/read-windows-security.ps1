# Fixed read-only identity/ACL operations for the reader's startup gate.
# No path or executable source is supplied as an inline PowerShell command.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('CurrentUserSid', 'PrivateAcl')]
    [string]$Operation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

switch ($Operation) {
    'CurrentUserSid' {
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
    'PrivateAcl' {
        $targetPath = $env:DSH_READER_ACL_PATH
        if ([string]::IsNullOrWhiteSpace($targetPath)) {
            throw 'Missing reader ACL target.'
        }
        $sidType = [System.Security.Principal.SecurityIdentifier]
        $acl = if ([System.IO.Directory]::Exists($targetPath)) {
            [System.IO.DirectoryInfo]::new($targetPath).GetAccessControl()
        } else {
            [System.IO.FileInfo]::new($targetPath).GetAccessControl()
        }
        [pscustomobject]@{
            ownerSid = $acl.GetOwner($sidType).Value
            access = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
                [pscustomobject]@{
                    sid = $_.IdentityReference.Value
                    accessControlType = $_.AccessControlType.ToString()
                    fileSystemRights = $_.FileSystemRights.ToString()
                    isInherited = $_.IsInherited
                }
            })
        } | ConvertTo-Json -Compress -Depth 4
    }
}
