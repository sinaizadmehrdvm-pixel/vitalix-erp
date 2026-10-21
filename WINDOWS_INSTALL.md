# VITALIX ERP — Windows setup

## Requirements

- Windows 10 or 11 (64-bit)
- Python 3.12 with **Add Python to PATH** enabled
- Node.js 22 LTS
- At least 2 GB of free disk space

## First installation

1. Extract the VITALIX project to a permanent folder such as `C:\VetrixERP`.
2. Double-click `scripts\windows\setup-vetrix.bat`.
3. Wait until **Setup completed successfully** appears.
4. Open the generated `.env` file and replace `VETRIX_JWT_SECRET` with a private random value of at least 32 characters.
5. Double-click `scripts\windows\start-vetrix.bat`.
6. Keep the Backend and Frontend terminal windows open while using VITALIX.
7. The browser opens at `http://127.0.0.1:5173`.

## Validate before real use

Run `scripts\windows\check-vetrix.bat`. It validates dependencies, runs all backend tests, compiles Python, audits frontend dependencies and routes, and creates a production build.

After logging in as administrator, open **System Health** and check **Release Preflight** through `/api/system/release-preflight`. Production release is allowed only when `release_ready` is true.

## Production settings

Set `VETRIX_ENV=production`, use a unique JWT secret longer than 32 characters, and list only trusted frontend origins in `VETRIX_ALLOWED_ORIGINS`. Never use `*` for production CORS.

## Backup

Enable automatic backup in Settings and verify at least one backup before entering real financial data.
