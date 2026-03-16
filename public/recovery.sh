#!/bin/bash
set -euo pipefail

# Claw-Fridge Recovery Script
# Usage: curl -fsSL https://your-fridge.example.com/recovery.sh | bash -s -- [options]

VERSION="1.0.0"
DEFAULT_TARGET_DIR="$HOME"
DEFAULT_BRANCH_PREFIX="ice-box"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Show usage
show_usage() {
  cat <<EOF
Claw-Fridge Recovery Script v${VERSION}

Usage: $0 [OPTIONS]

Options:
  -r, --repository URL      Git repository URL (required)
  -m, --machine-id ID       Machine ID to restore (required)
  -t, --target-dir DIR      Target directory (default: \$HOME)
  -b, --branch BRANCH       Backup branch (default: ice-box/<machine-id>)
  -c, --commit HASH         Specific commit to restore (optional)
  -k, --ssh-key PATH        SSH private key path (optional)
  -u, --username USER       Git username for HTTPS auth (optional)
  -p, --token TOKEN         Git token/password for HTTPS auth (optional)
  -h, --help                Show this help message

Examples:
  # Restore from SSH repository
  $0 -r git@github.com:user/fridge.git -m my-laptop

  # Restore from HTTPS repository with token
  $0 -r https://github.com/user/fridge.git -m my-laptop -u myuser -p ghp_xxx

  # Restore to specific directory
  $0 -r git@github.com:user/fridge.git -m my-laptop -t /home/user

  # Restore specific commit
  $0 -r git@github.com:user/fridge.git -m my-laptop -c abc123

EOF
}

# Parse arguments
parse_args() {
  REPOSITORY=""
  MACHINE_ID=""
  TARGET_DIR="$DEFAULT_TARGET_DIR"
  BRANCH=""
  COMMIT=""
  SSH_KEY=""
  USERNAME=""
  TOKEN=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      -r|--repository)
        REPOSITORY="$2"
        shift 2
        ;;
      -m|--machine-id)
        MACHINE_ID="$2"
        shift 2
        ;;
      -t|--target-dir)
        TARGET_DIR="$2"
        shift 2
        ;;
      -b|--branch)
        BRANCH="$2"
        shift 2
        ;;
      -c|--commit)
        COMMIT="$2"
        shift 2
        ;;
      -k|--ssh-key)
        SSH_KEY="$2"
        shift 2
        ;;
      -u|--username)
        USERNAME="$2"
        shift 2
        ;;
      -p|--token)
        TOKEN="$2"
        shift 2
        ;;
      -h|--help)
        show_usage
        exit 0
        ;;
      *)
        log_error "Unknown option: $1"
        show_usage
        exit 1
        ;;
    esac
  done

  # Validate required parameters
  if [[ -z "$REPOSITORY" ]]; then
    log_error "Repository URL is required. Use -r or --repository."
    show_usage
    exit 1
  fi

  if [[ -z "$MACHINE_ID" ]]; then
    log_error "Machine ID is required. Use -m or --machine-id."
    show_usage
    exit 1
  fi

  # Set default branch if not specified
  if [[ -z "$BRANCH" ]]; then
    BRANCH="${DEFAULT_BRANCH_PREFIX}/${MACHINE_ID}"
  fi
}

# Check prerequisites
check_prerequisites() {
  log_info "Checking prerequisites..."

  if ! command -v git &> /dev/null; then
    log_error "Git is not installed. Please install git first."
    exit 1
  fi

  if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
    log_error "Either curl or wget is required."
    exit 1
  fi

  log_success "Prerequisites check passed."
}

# Setup Git authentication
setup_git_auth() {
  log_info "Setting up Git authentication..."

  # Configure SSH if key is provided
  if [[ -n "$SSH_KEY" ]]; then
    if [[ ! -f "$SSH_KEY" ]]; then
      log_error "SSH key not found: $SSH_KEY"
      exit 1
    fi

    # Start SSH agent and add key
    eval "$(ssh-agent -s)"
    ssh-add "$SSH_KEY"

    log_success "SSH key added: $SSH_KEY"
  fi

  # Configure credential helper for HTTPS
  if [[ -n "$USERNAME" ]] && [[ -n "$TOKEN" ]]; then
    # Create credential helper
    cat > /tmp/git-credential-helper.sh <<EOF
#!/bin/bash
echo "username=$USERNAME"
echo "password=$TOKEN"
EOF
    chmod +x /tmp/git-credential-helper.sh

    log_success "Git credentials configured for HTTPS."
  fi
}

# Create temporary directory
create_temp_dir() {
  TEMP_DIR=$(mktemp -d)
  log_info "Created temporary directory: $TEMP_DIR"
}

# Clone repository
clone_repository() {
  log_info "Cloning repository..."

  local clone_url="$REPOSITORY"
  local git_env=()

  # Setup environment for credentials
  if [[ -n "$USERNAME" ]] && [[ -n "$TOKEN" ]]; then
    git_env+=("GIT_ASKPASS=/tmp/git-credential-helper.sh")
  fi

  # Clone with shallow depth for faster download
  if ! env "${git_env[@]}" git clone --no-checkout --depth 50 "$clone_url" "$TEMP_DIR/repo" 2>&1; then
    log_error "Failed to clone repository: $clone_url"
    exit 1
  fi

  cd "$TEMP_DIR/repo"

  # Fetch the specific branch with depth
  if ! env "${git_env[@]}" git fetch --depth 50 origin "$BRANCH" 2>&1; then
    log_error "Branch not found: $BRANCH"
    log_info "Available branches:"
    git branch -r | grep "$DEFAULT_BRANCH_PREFIX" || true
    exit 1
  fi

  # Checkout branch or specific commit
  if [[ -n "$COMMIT" ]]; then
    log_info "Checking out commit: $COMMIT"
    if ! git checkout "$COMMIT" 2>&1; then
      log_error "Failed to checkout commit: $COMMIT"
      exit 1
    fi
  else
    log_info "Checking out branch: $BRANCH"
    if ! git checkout FETCH_HEAD 2>&1; then
      log_error "Failed to checkout branch: $BRANCH"
      exit 1
    fi
  fi

  log_success "Repository cloned and checked out successfully."
}

# Verify .openclaw directory exists
verify_backup() {
  log_info "Verifying backup..."

  if [[ ! -d ".openclaw" ]]; then
    log_error "No .openclaw directory found in backup."
    exit 1
  fi

  local file_count=$(find .openclaw -type f | wc -l)
  log_success "Backup verified: $file_count files found."
}

# Restore backup
restore_backup() {
  local target_path="$TARGET_DIR/.openclaw"

  log_info "Restoring backup to: $target_path"

  # Check if target already exists
  if [[ -d "$target_path" ]]; then
    log_warning "Target directory already exists: $target_path"

    # Create backup of existing directory
    local backup_path="$TARGET_DIR/.openclaw.backup.$(date +%Y%m%d_%H%M%S)"
    log_info "Creating backup of existing directory: $backup_path"
    mv "$target_path" "$backup_path"
  fi

  # Ensure target directory exists
  mkdir -p "$TARGET_DIR"

  # Copy .openclaw directory
  if ! cp -r .openclaw "$target_path"; then
    log_error "Failed to restore backup to: $target_path"
    exit 1
  fi

  log_success "Backup restored successfully to: $target_path"
}

# Cleanup temporary files
cleanup() {
  if [[ -n "${TEMP_DIR:-}" ]] && [[ -d "$TEMP_DIR" ]]; then
    log_info "Cleaning up temporary files..."
    rm -rf "$TEMP_DIR"
  fi

  if [[ -f "/tmp/git-credential-helper.sh" ]]; then
    rm -f /tmp/git-credential-helper.sh
  fi

  # Kill SSH agent if we started it
  if [[ -n "${SSH_AGENT_PID:-}" ]]; then
    kill "$SSH_AGENT_PID" 2>/dev/null || true
  fi
}

# Main function
main() {
  trap cleanup EXIT

  log_info "Claw-Fridge Recovery Script v${VERSION}"
  log_info "========================================"

  parse_args "$@"
  check_prerequisites
  setup_git_auth
  create_temp_dir
  clone_repository
  verify_backup
  restore_backup

  log_success "========================================"
  log_success "Recovery completed successfully!"
  log_success "OpenClaw configuration restored to: $TARGET_DIR/.openclaw"
  log_success ""
  log_success "Next steps:"
  log_success "1. Restart OpenClaw if it's running"
  log_success "2. Verify your configuration"
  log_success "3. Run 'openclaw status' to check everything is working"
}

# Run main function
main "$@"
