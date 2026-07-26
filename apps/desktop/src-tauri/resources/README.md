# Distribution resources staging area

Generated Windows distribution resources are staged here by
`tools/distribution/Stage-DistributionResources.ps1` before a non-dry-run NSIS
build.

The generated contents are intentionally ignored by git because they include
large locked model/runtime artifacts. Keep only this explanation and `.gitignore`
under version control.
