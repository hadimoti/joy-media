# JOY Media Windows self-hosted runner contract

Required labels: `self-hosted,windows,x64,joy-media-ci`

This is the only accepted Windows CI lane for JOY Media private repositories.
It runs in a Windows Docker Desktop container on the owner-controlled PC.
Host-direct Windows runners and Linux portable workers are not substitutes.

The release workflow must pass the exact candidate SHA and write the complete
Windows acceptance record before `release:gate` can pass. See
[contract.md](contract.md) for the build, registration, token, and
container-local acceptance contract.
