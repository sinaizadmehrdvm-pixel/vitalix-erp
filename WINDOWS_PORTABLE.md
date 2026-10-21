VITALIX ERP 1.4.1 — Windows Portable

Local use (default and safest mode)

1. Extract the ZIP into a permanent folder.
2. Double-click VITALIXERP.exe.
3. Keep the VITALIX console window open while using the program.
4. Your browser opens automatically at http://127.0.0.1:5173.
5. On first run, create the administrator account and keep its password safe.

The default mode binds only to this computer. No separate Python or Node.js installation is required.

Server/client use on a trusted local network

Use this only on a private, trusted LAN. The server computer stores the database and must remain running. Client computers use a browser and do not receive a separate database copy.

1. Give the server computer a stable private IPv4 address, for example 192.168.1.20.
2. Open PowerShell in the extracted VITALIX folder.
3. Set the exact public browser origin and start VITALIX:

   $env:VETRIX_LAN_ENABLED="true"
   $env:VETRIX_ALLOWED_ORIGINS="http://192.168.1.20:5173,http://127.0.0.1:5173"
   .\VITALIXERP.exe

4. On Windows Firewall, allow inbound TCP ports 5173 and 8001 only for the Private network profile.
5. On each client, open http://192.168.1.20:5173 and sign in with an authorized account.

Replace 192.168.1.20 with the server's actual private address. The value in VETRIX_ALLOWED_ORIGINS must include the exact scheme, address, and web port used by clients. Wildcard CORS is rejected. LAN mode also refuses to start unless at least one non-loopback origin is configured.

Optional ports

Set VETRIX_WEB_PORT and VETRIX_API_PORT before startup if the defaults conflict. They must be different and between 1 and 65535. If the web port changes, use the same port in VETRIX_ALLOWED_ORIGINS. The packaged frontend currently expects the API on port 8001, so a custom API port requires a build configured with VITE_API_URL.

Security checklist

- Use only a trusted private network; do not expose VITALIX directly to the internet.
- Keep Windows Firewall scoped to Private networks and, when possible, to the local subnet.
- Never use "*" as an allowed origin.
- Create separate named user accounts and grant only required roles.
- Keep the generated desktop-config.json private because it contains the signing secret.
- Use a VPN or properly managed reverse proxy with HTTPS for remote access; direct router port-forwarding is not supported.
- Back up and verify recovery regularly before enabling additional clients.

Data location

%LOCALAPPDATA%\VetrixERP
- vetrix.db: accounting database
- backups: verified backups
- uploads: local attachments
- desktop-config.json: private desktop configuration

Back up the entire data folder regularly. Before moving to another PC, close VITALIX and copy the data folder plus a verified application backup. Never run two server instances against the same copied database.

If Windows Defender displays a warning for an unsigned internal build, verify the SHA-256 file included with the download before running it. Public distribution should use a code-signing certificate.

To stop VITALIX, close the VITALIX console window.
