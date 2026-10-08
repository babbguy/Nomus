#!/usr/bin/env bash
# ============================================================================
# Nomus bare-metal setup (example)
#
# Installs Nomus on a fresh Ubuntu 22.04+ server: Node.js, PM2, Nginx and a
# Let's Encrypt certificate. Review it before running - it installs packages,
# configures the firewall and writes to /etc/nginx. The Docker Compose setup
# described in docs/admin-guide/deployment.md is the simpler option.
#
# Usage:
#   DOMAIN=nomus.example.com ADMIN_EMAIL=you@example.com bash infra/setup-vps.sh
# ============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/nomus}"
REPO_URL="${REPO_URL:-https://github.com/babbguy/Nomus.git}"
NODE_VERSION="20"

# Admin login address for the first account. Deliberately has no default:
# the engine refuses to start in production with a published address as the
# admin login, so baking one in here would produce a .env that cannot boot.
ADMIN_EMAIL="${ADMIN_EMAIL:-}"

# ============================================================================
# Colors
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Nomus]${NC} $1"; }
warn() { echo -e "${YELLOW}[Nomus]${NC} $1"; }
err()  { echo -e "${RED}[Nomus]${NC} $1" >&2; }

# ============================================================================
# Preflight
# ============================================================================
if [[ $EUID -ne 0 ]]; then
    err "This script must be run as root (or with sudo)."
    exit 1
fi

if [[ -z "${DOMAIN}" ]]; then
    err "DOMAIN is required (the hostname that points at this server), e.g.:"
    err ""
    err "    DOMAIN=nomus.example.com ADMIN_EMAIL=you@example.com bash setup-vps.sh"
    exit 1
fi

if [[ -z "${ADMIN_EMAIL}" ]]; then
    err "ADMIN_EMAIL is required — it becomes the first admin login."
    err "Production refuses to start with a published address as the admin"
    err "account, so pick a real mailbox you control, e.g.:"
    err ""
    err "    DOMAIN=nomus.example.com ADMIN_EMAIL=you@yourdomain.com bash setup-vps.sh"
    exit 1
fi

log "Starting Nomus VPS setup for ${DOMAIN}"
log "Install directory: ${INSTALL_DIR}"
log "Admin login:       ${ADMIN_EMAIL}"

# ============================================================================
# 1. System packages
# ============================================================================
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

log "Installing prerequisites..."
apt-get install -y -qq \
    curl wget git build-essential \
    nginx certbot python3-certbot-nginx \
    ufw sqlite3 jq

# ============================================================================
# 2. Node.js 20 via NodeSource
# ============================================================================
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_VERSION" ]]; then
    log "Installing Node.js ${NODE_VERSION}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
else
    log "Node.js $(node -v) already installed."
fi

# ============================================================================
# 3. PM2
# ============================================================================
if ! command -v pm2 &>/dev/null; then
    log "Installing PM2..."
    npm install -g pm2
    pm2 startup systemd -u root --hp /root
else
    log "PM2 already installed."
fi

# ============================================================================
# 4. Firewall (UFW)
# ============================================================================
log "Configuring UFW firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 'Nginx Full'
ufw --force enable

# ============================================================================
# 5. Clone and build Nomus
# ============================================================================
if [[ -d "${INSTALL_DIR}" ]]; then
    warn "${INSTALL_DIR} already exists. Pulling latest..."
    cd "${INSTALL_DIR}"
    git pull origin main
else
    log "Cloning repository..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

log "Installing npm dependencies..."
npm ci

log "Building Nomus packages..."
npm run build:packages

log "Building Nomus Engine..."
npm run build:engine

log "Building Nomus Dashboard..."
npm run build:dashboard

# ============================================================================
# 6. Directory structure
# ============================================================================
log "Creating directories..."
mkdir -p "${INSTALL_DIR}/data"
mkdir -p "${INSTALL_DIR}/logs"
mkdir -p "${INSTALL_DIR}/backups"
mkdir -p /var/www/certbot

# ============================================================================
# 7. Generate secrets and .env
# ============================================================================
if [[ -f "${INSTALL_DIR}/.env" ]]; then
    warn ".env already exists — skipping generation. Review manually."
else
    log "Generating secrets..."

    SIGNING_KEY=$(openssl rand -hex 32)
    ADMIN_BOOTSTRAP_KEY=$(openssl rand -hex 16)
    ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '=/+' | head -c 24)

    cat > "${INSTALL_DIR}/.env" << ENVEOF
# ============================================================================
# Nomus Production Environment — ${DOMAIN}
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# ============================================================================

# Core
NOMUS_ENV=production
NOMUS_PORT=3100
NOMUS_LOG_LEVEL=info
NOMUS_LOG_FORMAT=json

# Database
NOMUS_DB_PATH=./data/nomus.db

# Security (auto-generated — keep these safe)
NOMUS_SIGNING_KEY_SECRET=${SIGNING_KEY}
NOMUS_ADMIN_BOOTSTRAP_KEY=${ADMIN_BOOTSTRAP_KEY}

# Admin account
NOMUS_ADMIN_EMAIL=${ADMIN_EMAIL}
NOMUS_ADMIN_PASSWORD=${ADMIN_PASSWORD}

# CORS — dashboard is same-origin, restrict to domain
NOMUS_CORS_ORIGIN=https://${DOMAIN}

# LLM — Uncomment and fill in the providers you use
# NOMUS_ANTHROPIC_API_KEY=
# NOMUS_GOOGLE_AI_KEY=
# NOMUS_OPENAI_API_KEY=
# NOMUS_LLM_CLASSIFIER_PROVIDER=anthropic
# NOMUS_LLM_CLASSIFIER_MODEL=claude-haiku-4-5-20251001

# Scout (regulatory prediction)
NOMUS_SCOUT_ENABLED=true
NOMUS_SCOUT_CRON=0 */6 * * *

# Scraping schedule (daily at 2 AM, server local time)
NOMUS_SCRAPE_CRON=0 2 * * *

# Rule approval
NOMUS_REQUIRE_RULE_APPROVAL=false

# Email (Resend) — optional
# NOMUS_RESEND_API_KEY=
# NOMUS_FROM_EMAIL=Nomus <noreply@${DOMAIN}>

# Notifications — optional
# NOMUS_SLACK_WEBHOOK_URL=
# NOMUS_NTFY_URL=https://ntfy.sh
# NOMUS_NTFY_TOPIC=nomus-alerts

# GitHub App — optional
# NOMUS_GITHUB_APP_ID=
# NOMUS_GITHUB_APP_PRIVATE_KEY=
# NOMUS_GITHUB_WEBHOOK_SECRET=
# NOMUS_GITHUB_CLIENT_ID=
# NOMUS_GITHUB_CLIENT_SECRET=

ENVEOF

    chmod 600 "${INSTALL_DIR}/.env"

    echo ""
    log "=========================================="
    log "  SAVE THESE CREDENTIALS NOW"
    log "=========================================="
    log "  Admin Email:          ${ADMIN_EMAIL}"
    log "  Admin Password:       ${ADMIN_PASSWORD}"
    log "  Admin Bootstrap Key:  ${ADMIN_BOOTSTRAP_KEY}"
    log "  Signing Key Secret:   ${SIGNING_KEY}"
    log "=========================================="
    log "  .env location: ${INSTALL_DIR}/.env"
    log "=========================================="
    echo ""
fi

# ============================================================================
# 8. Nginx configuration
# ============================================================================
log "Configuring Nginx..."

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Copy the Nomus nginx config, substituting the deployment domain. The shipped
# file carries the placeholder hostname nomus.example.com in server_name and in
# the certificate paths; both must follow ${DOMAIN}.
sed "s/nomus\.example\.com/${DOMAIN}/g" \
    "${INSTALL_DIR}/infra/nginx.conf" > /etc/nginx/sites-available/nomus.conf
ln -sf /etc/nginx/sites-available/nomus.conf /etc/nginx/sites-enabled/nomus.conf

# Test nginx config (will fail on SSL certs not yet existing, so use HTTP-only temporarily)
# First, install with a temporary HTTP-only config for certbot
cat > /etc/nginx/sites-available/nomus-temp.conf << TEMPEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 200 'Nomus setup in progress';
        add_header Content-Type text/plain;
    }
}
TEMPEOF

ln -sf /etc/nginx/sites-available/nomus-temp.conf /etc/nginx/sites-enabled/nomus-temp.conf
rm -f /etc/nginx/sites-enabled/nomus.conf

nginx -t && systemctl restart nginx

# ============================================================================
# 9. SSL via Certbot
# ============================================================================
log "Requesting SSL certificate for ${DOMAIN}..."
certbot certonly --webroot \
    -w /var/www/certbot \
    -d "${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    --email "${ADMIN_EMAIL}" \
    --no-eff-email

# Now switch to the real nginx config
rm -f /etc/nginx/sites-enabled/nomus-temp.conf
rm -f /etc/nginx/sites-available/nomus-temp.conf
ln -sf /etc/nginx/sites-available/nomus.conf /etc/nginx/sites-enabled/nomus.conf

nginx -t && systemctl restart nginx
log "SSL configured and Nginx restarted."

# Set up certbot auto-renewal
systemctl enable certbot.timer

# ============================================================================
# 10. Start Nomus via PM2
# ============================================================================
log "Starting Nomus Engine via PM2..."
cd "${INSTALL_DIR}"
pm2 start "${INSTALL_DIR}/infra/ecosystem.cjs"
pm2 save

# ============================================================================
# 11. Deploy script
# ============================================================================
log "Creating deploy script..."
cat > "${INSTALL_DIR}/deploy.sh" << 'DEPLOYEOF'
#!/usr/bin/env bash
# Nomus deploy script — pull, build, restart
# Usage: /opt/nomus/deploy.sh
set -euo pipefail

INSTALL_DIR="/opt/nomus"

echo "[Nomus] Starting deployment at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

cd "${INSTALL_DIR}"

echo "[Nomus] Pulling latest code..."
git pull origin main

echo "[Nomus] Installing dependencies..."
npm ci

echo "[Nomus] Building packages..."
npm run build:packages

echo "[Nomus] Building Nomus Engine..."
npm run build:engine

echo "[Nomus] Building Nomus Dashboard..."
npm run build:dashboard

echo "[Nomus] Restarting Nomus Engine..."
pm2 restart nomus-engine

echo "[Nomus] Deployment complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEPLOYEOF

chmod +x "${INSTALL_DIR}/deploy.sh"

# ============================================================================
# 12. Daily database backup cron
# ============================================================================
log "Setting up daily database backup..."
CRON_CMD="0 3 * * * /usr/bin/sqlite3 ${INSTALL_DIR}/data/nomus.db \".backup '${INSTALL_DIR}/backups/nomus-\$(date +\\%Y\\%m\\%d).db'\" && find ${INSTALL_DIR}/backups -name 'nomus-*.db' -mtime +30 -delete"
(crontab -l 2>/dev/null | grep -v "nomus.db" ; echo "${CRON_CMD}") | crontab -

# ============================================================================
# 13. File permissions
# ============================================================================
log "Setting file permissions..."
chmod 700 "${INSTALL_DIR}/data"
chmod 700 "${INSTALL_DIR}/backups"
chmod 755 "${INSTALL_DIR}/logs"

# ============================================================================
# Done
# ============================================================================
echo ""
log "============================================"
log "  Nomus deployment complete!"
log "============================================"
log "  URL:        https://${DOMAIN}"
log "  Engine:     pm2 status nomus-engine"
log "  Logs:       pm2 logs nomus-engine"
log "  Deploy:     ${INSTALL_DIR}/deploy.sh"
log "  Backups:    ${INSTALL_DIR}/backups/"
log "  Nginx:      /etc/nginx/sites-available/nomus.conf"
log "  .env:       ${INSTALL_DIR}/.env"
log ""
log "  NEXT STEPS:"
log "  1. Add LLM API keys to .env"
log "  2. Save the admin credentials printed above"
log "  3. Visit https://${DOMAIN} to verify"
log "============================================"
