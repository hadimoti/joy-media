# PSD import fixtures

The PSD importer tests use bounded synthetic layer documents so they do not
check in third-party artwork or large binary files. A real user PSD is read
through `ag-psd` only after the byte, pixel, and memory limits are checked.
