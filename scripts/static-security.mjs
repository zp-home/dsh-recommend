/**
 * static-security.mjs v4 — enhanced zero-dependency source-only plugin security scanner.
 *
 * NEVER executes any target code. Reads text files only.
 * Detects: execution patterns, data exfiltration, persistence, skill hijacking,
 *           obfuscation, supply-chain risks, sandbox escape attempts, and more.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ═══════════════════════════════════════════════════════════════
// Constants & Limits
// ═══════════════════════════════════════════════════════════════
const FORMAT = 'dsh-plugin-verification/v1'
export const SCANNER_VERSION = 8
export const RULESET_VERSION = '2026-16'
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 8000
const MAX_FINDINGS = 300
const MAX_MATCHES_PER_RULE_FILE = 5

// Generated plugin bundles are part of the install surface. Do not skip dist/
// or build/: the scanner must inspect code a plugin installation can execute.
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'coverage', '.next', '.turbo',
  '.cache', '.parcel-cache', 'vendor',
])

const CODE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts',
  '.jsx', '.tsx', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.psd1', '.cmd', '.bat', '.hta',
  '.py', '.rb', '.php', '.pl', '.lua', '.go', '.rs', '.cr',
  '.cs', '.java', '.kt', '.scala', '.swift', '.m', '.mm',
])

const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.md', '.rst', '.txt', '.xml'])

const SKILL_FILE = /(?:^|\/)(?:SKILL|AGENTS|CLAUDE|SYSTEM|RULES)\.md$/i
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i
const README_FILE = /(?:^|\/)(?:README|LICENSE|SECURITY|CONTRIBUTING|CHANGELOG)\.?(?:md|txt)?$/i
const MANIFEST_FILE = /^package\.json$/i
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures|spec|__mocks__|contracts?|examples?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i

const SUSPICIOUS_DOMAINS = [
  'pastebin\\.com', 'paste\\.ee', 'hastebin', 'transfer\\.sh', '0x0\\.st',
  'ngrok\\.io', 'localtunnel\\.me', 'serveo\\.net', 'localhost\\.run',
  'webhook\\.site', 'endpoint\\.chat', 'smee\\.io',
  'raw\\.githubusercontent\\.com', 'gist\\.github',
  'bit\\.ly', 'tinyurl\\.com', 'is\\.gd', 'goo\\.gl',
  'anonfiles\\.com', 'mega\\.nz', 'dropbox', 'drive\\.google',
  'ipify\\.org', 'ifconfig\\.me', 'ip-api\\.com',
]

// Helper: build a regex safely using the constructor to avoid
// delimiter-escaping issues with patterns containing slashes.
function re(source, flags = 'g') {
  return new RegExp(source, flags)
}

// ═══════════════════════════════════════════════════════════════
// Detection Patterns (built with constructor to avoid slash issues)
// ═══════════════════════════════════════════════════════════════
const SECRET_KEY_PATTERNS = [
  re("-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----", ''),
  re("\\b(?:github_pat|github_oauth|github_user_to_server)\\b", ''),
  re("\\b(?:sk|pk|rk|uk|tk|pk_live|rk_live|sk_live)_[A-Za-z0-9]{20,}", ''),
  re("AKIA[0-9A-Z]{16}", ''),
  re("ASIA[0-9A-Z]{16}", ''),
  re("\\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}", ''),
  re("\\b(?:xox[baprs])-[A-Za-z0-9-]{10,}", ''),
  re("\\b(?:eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})", ''),
  re("\\b(?:mongodb(?:\\+srv)?:\\/\\/[^\\s]+:[^\\s@]+@)", ''),
  re("\\b(?:redis:\\/\\/[^\\s]+:[^\\s@]+@)", ''),
  re("\\b(?:postgres(?:ql)?:\\/\\/[^\\s]+:[^\\s@]+@)", ''),
  re("\\b(?:mysql:\\/\\/[^\\s]+:[^\\s@]+@)", ''),
  re("\\b(?:smtp:\\/\\/[^\\s]+:[^\\s@]+@)", ''),
  re("\\bBearer\\s+[A-Za-z0-9_.-]{20,}", 'i'),
  re("\\bapi[_-]?key\\s*[:=]\\s*[\"\\'][A-Za-z0-9_.-]{16,}[\"\\']", 'i'),
  re("\\b(?:password|passwd|secret|token|apikey|api_key)\\s*[:=]\\s*[\"\\'][^\"\\'\\s]{8,}[\"\\']", 'i'),
]

const ENV_SENSITIVE_PATTERNS = [
  re("\\bprocess\\.env\\.[A-Z0-9_]*(?:API_KEY|API_SECRET|TOKEN|SECRET|PASSWORD|CREDENTIAL|CLIENT_SECRET|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY)\\b", 'i'),
  re("\\bprocess\\.env\\[\"\\'][A-Z0-9_]*(?:API_KEY|API_SECRET|TOKEN|SECRET|PASSWORD|CREDENTIAL|CLIENT_SECRET|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY)[\"\\']\\]", 'i'),
]

const EXECUTION_RULES = [
  { id: 'MKT-EXEC-002', family: 'execution', risk: 'high', confidence: 'high',
    message: 'evaluates dynamically generated JavaScript via eval/Function',
    remediation: 'Remove dynamic evaluation and use fixed allowlisted implementations.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\b(?:eval|Function)\\s*\\(", 'g') },
  { id: 'MKT-EXEC-003', family: 'execution', risk: 'high', confidence: 'high',
    message: 'downloads and pipes code directly to interpreter',
    remediation: 'Do not execute code downloaded at runtime; pin and review shipped code.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: re("\\b(?:curl|wget|Invoke-WebRequest|iwr|httpie|hx)\\b[^\\n]{0,200}\\|\\s*(?:sh|bash|zsh|pwsh|powershell|node|python|perl|ruby)|\\b(?:IEX|Invoke-Expression|Set-ExecutionPolicy)\\b", 'g') },
  { id: 'MKT-EXEC-006', family: 'execution', risk: 'high', confidence: 'high',
    message: 'uses WebAssembly compilation or instantiation',
    remediation: 'Review all WASM sources; untrusted WASM can execute arbitrary machine code.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\b(?:WebAssembly\\.(?:compile|instantiate|compileStreaming|instantiateStreaming|validate|table|memory|global|numeric))\\s*\\(", 'g') },
  { id: 'MKT-EXEC-007', family: 'execution', risk: 'high', confidence: 'high',
    message: 'loads native Node.js addon or uses dlopen',
    remediation: 'Require explicit user approval for native module loading; verify addon source integrity.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: re("require\\s*\\(\\s*[\"\\'][^\"\\']*\\.node[\"\\']\\s*\\)|process\\.dlopen\\s*\\(", 'g') },
  { id: 'MKT-EXEC-008', family: 'execution', risk: 'high', confidence: 'medium',
    message: 'uses vm module for script execution',
    remediation: 'Avoid vm.Context/runInNewContext with untrusted input; prefer static analysis.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\b(?:vm\\.(?:runInNewContext|runInContext|createContext|createScript|runInThisContext|Script))\\s*\\(", 'g') },
  { id: 'MKT-EXEC-009', family: 'execution', risk: 'medium', confidence: 'medium',
    message: 'dynamically imports code from a variable path',
    remediation: 'Use static imports with allowlisted modules; avoid dynamic import() with variable arguments.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\bimport\\s*\\(\\s*(?![\"\\'`])", 'g') },

  { id: 'MKT-EXEC-011', family: 'execution', risk: 'high', confidence: 'medium',
    message: 'uses constructor-based sandbox escape pattern',
    remediation: 'Avoid prototype manipulation that can lead to sandbox escape.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\.constructor\\.constructor\\s*\\(|constructor\\s*:\\s*(?:Proxy|Reflect|Object\\.prototype)", 'g') },
]

const DATA_EGRESS_RULES = [
  { id: 'MKT-DATA-001', family: 'data-egress', risk: 'high', confidence: 'high',
    message: 'contains a value shaped like a private credential or API key',
    remediation: 'Remove embedded credentials, rotate exposed secrets, and load them only from a protected secret store.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: null },
  { id: 'MKT-DATA-002', family: 'data-egress', risk: 'medium', confidence: 'high',
    message: 'disables TLS verification or references plaintext HTTP transport',
    remediation: 'Use HTTPS and keep TLS certificate verification enabled.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("rejectUnauthorized\\s*:\\s*false|NODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*[\"\\']?0|http:\\/\\/(?!localhost\\b|127\\.0\\.0\\.1\\b|0\\.0\\.0\\.0\\b)", 'g') },
  { id: 'MKT-DATA-004', family: 'data-egress', risk: 'medium', confidence: 'medium',
    message: 'detects net.connect, dgram.createSocket, or process-level network access',
    remediation: 'Review all network connections; ensure they use allowlisted destinations with explicit approval.',
    basis: 'OWASP Data Security Cheat Sheet',
    expression: re("\\b(?:net\\.connect|dgram\\.createSocket|net\\.createConnection|net\\.Server)\\s*\\(", 'g') },
  { id: 'MKT-DATA-005', family: 'data-egress', risk: 'high', confidence: 'medium',
    message: 'reads environment variables containing secrets',
    remediation: 'Never read sensitive environment variables and pass them to untrusted code or external services.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: null },
  { id: 'MKT-DATA-006', family: 'data-egress', risk: 'medium', confidence: 'medium',
    message: 'accesses system or user credential stores',
    remediation: 'Avoid direct access to credential files; use authenticated API flows instead.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: re("\\b(?:keychain|credential|password(s)?\\s*(?:store|manager|file)|windows\\.webauthn)\\b|\\.ssh[\\/\\\\]id_|\\.aws[\\/\\\\]credentials|\\.docker[\\/\\\\]config|\\/etc[\\/\\\\]passwd|\\/etc[\\/\\\\]shadow", 'g') },
  { id: 'MKT-DATA-007', family: 'data-egress', risk: 'medium', confidence: 'medium',
    message: 'makes HTTP request to a known high-risk or anonymous service',
    remediation: 'Route all network traffic through allowlisted, authenticated endpoints only.',
    basis: 'OWASP Data Security Cheat Sheet',
    expression: null },
]

const PERSISTENCE_RULES = [
  { id: 'MKT-PERSIST-001', family: 'persistence', risk: 'high', confidence: 'medium',
    message: 'references an operating-system persistence mechanism',
    remediation: 'Document and require explicit user approval for persistent operating-system changes.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\b(?:schtasks|crontab|RunOnce|LaunchAgents|systemctl\\s+enable|systemctl\\s+startup|update-rc\\.d|rcconf|sudoers|HKLM\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run|HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run)\\b", 'gi') },
  { id: 'MKT-PERSIST-002', family: 'persistence', risk: 'medium', confidence: 'medium',
    message: 'modifies shell initialization files',
    remediation: 'Require explicit user approval for any shell profile modification.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: re("\\b(?:\\.bashrc|\\.bash_profile|\\.zshrc|\\.profile|\\.bash_login|\\/etc\\/profile|\\/etc\\/bash\\.bashrc)\\b", 'g') },
  { id: 'MKT-PERSIST-003', family: 'persistence', risk: 'medium', confidence: 'medium',
    message: 'writes to system directories or boot locations',
    remediation: 'Restrict file writes to user-owned directories with explicit approval.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\/etc\\/(?:init\\.d|systemd|xdg|pam|ld\\.config|hosts|resolv\\.conf|fstab|sudoers)|\\/Library\\/(?:LaunchDaemons|LaunchAgents|Preferences)|\\b(?:Program Files|System32|SysWOW64)\\b", 'i') },
  { id: 'MKT-PERSIST-004', family: 'persistence', risk: 'high', confidence: 'medium',
    message: 'attempts to install as a system service or driver',
    remediation: 'Never attempt driver or service installation from user-level plugins.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\b(?:sc\\s+create|New-Service|Install-PsDriver|net\\s+(?:user|localgroup)|chroot\\b|systemd-nspawn)\\b", 'i') },
]

const OBFUSCATION_RULES = [
  { id: 'MKT-REVIEW-001', family: 'obfuscation', risk: 'medium', confidence: 'low',
    message: 'decodes base64-encoded content before dynamic execution',
    remediation: 'Ship readable source or document generated artifacts and their reproducible build inputs.',
    basis: 'OpenSSF npm supply-chain practices',
    expression: re("\\b(?:atob|Buffer\\.from)\\s*\\([^\\n]{0,200}base64[^\\n]{0,200}\\)\\s*(?:;|\\.)[^\\n]{0,200}\\b(?:eval|Function|new\\s+Function)\\s*\\(", 'g') },
  { id: 'MKT-REVIEW-002', family: 'obfuscation', risk: 'medium', confidence: 'low',
    message: 'uses string concatenation or char-code construction to hide keywords',
    remediation: 'Use readable, explicit code patterns; avoid character-code obfuscation.',
    basis: 'OpenSSF npm supply-chain practices',
    expression: re("String\\.fromCharCode\\s*\\([^)]{5,}\\)|String\\.fromCodePoint\\s*\\([^)]{5,}\\)|\\\\x[0-9a-fA-F]{2}\\\\x[0-9a-fA-F]{2}", 'g') },
  { id: 'MKT-REVIEW-003', family: 'obfuscation', risk: 'medium', confidence: 'low',
    message: 'contains multiple layers of encoding (hex/base64/unicode escapes)',
    remediation: 'Avoid multi-layer encoding; it hindles review and may indicate malicious intent.',
    basis: 'OpenSSF npm supply-chain practices',
    expression: re("\\\\u[0-9a-fA-F]{4}[^}]{0,50}[\\\\x\\\\u][0-9a-fA-F]{2,4}[^}]{0,50}[\\\\x\\\\u][0-9a-fA-F]{2,4}", 'g') },
  { id: 'MKT-REVIEW-004', family: 'obfuscation', risk: 'medium', confidence: 'low',
    message: 'uses obfuscation libraries or eval-like patterns with code generation',
    remediation: 'Avoid obfuscation at install time; keep runtime code inspectable.',
    basis: 'OpenSSF npm supply-chain practices',
    expression: re("\\b(?:javascript-obfuscator|uglify-js|terser|minify)\\b", 'g') },
  { id: 'MKT-REVIEW-005', family: 'obfuscation', risk: 'medium', confidence: 'low',
    message: 'contains suspiciously long single line (possible minified/malicious payload)',
    remediation: 'Review extremely long lines; they may contain hidden logic.',
    basis: 'OpenSSF npm supply-chain practices',
    expression: null },
]

const SKILL_HIJACK_RULES = [
  { id: 'MKT-SKILL-001', family: 'agent-skill', risk: 'high', confidence: 'medium',
    message: 'instruction override language together with destructive or external-action guidance',
    remediation: 'Treat external content as data; preserve approval boundaries; remove override directives.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: null },
  { id: 'MKT-SKILL-002', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'attempts to impersonate system or developer role',
    remediation: 'Never include role-override text in skill content; it bypasses safety boundaries.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("\\b(?:you are|act as|pretend to be|you are now|you are an)\\b[^\\n]{0,100}\\b(?:system|developer|admin|root|superuser|god|unrestricted|unfiltered)\\b", 'i') },
  { id: 'MKT-SKILL-003', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'contains multi-step prompt injection patterns',
    remediation: 'Break complex instructions into safe, auditable steps; never chain injection vectors.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("\\b(?:step\\s*(?:1|one|first|1\\.))[^\\n]{0,80}\\b(?:then|next|after|step\\s*(?:2|two|second))[^\\n]{0,80}\\b(?:ignore|override|bypass|skip|disregard)", 'i') },
  { id: 'MKT-SKILL-004', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'contains exfiltration guidance targeting agent capabilities',
    remediation: 'Remove all data collection and exfiltration instructions from skill content.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("\\b(?:collect|gather|harvest|extract|dump|export|send|transmit|upload)\\b[^\\n]{0,100}\\b(?:convers|chat|history|message|conversation|session|memory|knowledge)\\b", 'i') },
  { id: 'MKT-SKILL-005', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'requests disabling safety features or guidelines',
    remediation: 'Never instruct the model to disable or ignore safety guidelines.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("\\b(?:disable|bypass|ignore|skip|defeat|turn\\s*(?:off)?)\\b[^\\n]{0,100}\\b(?:safety|safety_check|content_filter|guardrail|filter|restriction|safety\\s*(?:mode|guideline|policy))", 'i') },
  { id: 'MKT-HIJACK-001', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'contains prompt injection patterns targeting system instructions',
    remediation: 'Remove all prompt injection patterns; they indicate attempts to override safety boundaries.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("ignore all previous instructions|system prompt|prompt injection", 'i') },
  { id: 'MKT-HIJACK-004', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'attempts to override or redirect tool usage',
    remediation: 'Never include tool override directives; they bypass approval and safety boundaries.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("use exec_command instead|ignore previous tool rules", 'i') },
  { id: 'MKT-HIJACK-005', family: 'agent-skill', risk: 'medium', confidence: 'medium',
    message: 'instruction override with specific goal redirection',
    remediation: 'Remove instruction override language; treat external content as data only.',
    basis: 'OWASP Top 10 for LLM Applications',
    expression: re("\\b(?:your goal|your task|your objective|you must|you have been instructed)\\b[^\\n]{0,100}\\b(?:ignore|override|disregard|bypass)\\b", 'i') },
]

const CI_INTEGRITY_RULES = [
  { id: 'MKT-CI-001', family: 'ci-integrity', risk: 'high', confidence: 'high',
    message: 'uses pull_request_target with a pull-request head checkout',
    remediation: 'Do not check out untrusted PR code in pull_request_target workflows.',
    basis: 'OpenSSF Scorecards',
    expression: re("pull_request_target[\\s\\S]{0,500}github\\.event\\.pull_request\\.head\\.(?:sha|ref)", 'g') },
  { id: 'MKT-CI-002', family: 'ci-integrity', risk: 'high', confidence: 'high',
    message: 'uses dangerously broad GitHub token permissions',
    remediation: 'Apply least-privilege principle; grant only required scopes.',
    basis: 'OpenSSF Scorecards',
    expression: re("\\b(?:contents(?:\\s*:\\s*(?:write|admin))|pull-requests(?:\\s*:\\s*write)|workflow(?:s?\\s*:\\s*write)|secrets(?:\\s*:\\s*write))\\b", 'g') },
  { id: 'MKT-CI-003', family: 'ci-integrity', risk: 'medium', confidence: 'medium',
    message: 'checks out code without persist-credentials protection',
    remediation: 'Use persist-credentials: false when checking out external/untrusted repositories.',
    basis: 'OpenSSF Scorecards',
    expression: re("actions\\/checkout[^\\n]{0,100}(?!persist-credentials[^\\n]{0,50}false)", 'gi') },
  { id: 'MKT-CI-004', family: 'ci-integrity', risk: 'high', confidence: 'medium',
    message: 'runs npm/pip install with compromised dependency potential',
    remediation: 'Use lock files and pin versions; add provenance/sL3.0 verification.',
    basis: 'OpenSSF Scorecards',
    expression: re("\\b(?:npm|pnpm|yarn|pip|pip3)\\s+(?:install|install\\s+-g|add|update)\\s+(?!lock|file|check)", 'gi') },
  { id: 'MKT-CI-005', family: 'ci-integrity', risk: 'high', confidence: 'medium',
    message: 'uses curl/wget to fetch arbitrary scripts and execute them',
    remediation: 'Verify fetched content before execution; use checksum-verified artifacts.',
    basis: 'OpenSSF Scorecards',
    expression: re("\\b(?:curl|wget)\\b[^\\n]{0,100}\\|\\s*(?:bash|sh|zsh|node|python)", 'gi') },
]

const FILESYSTEM_RULES = [
  { id: 'MKT-FS-001', family: 'file-system', risk: 'high', confidence: 'medium',
    message: 'invokes a file-system mutation API without workspace boundary protection',
    remediation: 'Require explicit user approval and restrict mutations to an allowlisted workspace path.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: null },
  { id: 'MKT-FS-002', family: 'file-system', risk: 'high', confidence: 'high',
    message: 'attempts to write outside workspace boundaries',
    remediation: 'Validate all file paths against workspace root; reject traversal patterns.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\b(?:writeFile|appendFile|copyFile|rename|mkdir|chmod|truncate|unlink|rm|rmdir|fs\\.promises\\.writeFile)\\s*\\(\\s*(?:[\"\\'`]\\.\\.[\\\\/]|[\"\\'`]\\.\\.\\\\\\\\|[\"\\'`]\\/etc|[\"\\'`]\\/var|[\"\\'`]\\/usr|[\"\\'`]\\/boot|[\"\\'`]\\.\\.[\\\\/])", 'g') },
  { id: 'MKT-FS-003', family: 'file-system', risk: 'medium', confidence: 'medium',
    message: 'reads sensitive system or credential files',
    remediation: 'Never read system files, credential stores, or environment files from plugins.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: re("\\/etc\\/(?:passwd|shadow|hosts|resolv\\.conf|sudoers|pam\\.d)|\\b(?:\\.ssh[\\/\\\\](?:id_|known_hosts)|\\/\\.aws[\\/\\\\]credentials|\\/\\.docker[\\/\\\\]config\\.json)", 'g') },
  { id: 'MKT-FS-004', family: 'file-system', risk: 'medium', confidence: 'medium',
    message: 'attempts path traversal with encoded or nested patterns',
    remediation: 'Use path.resolve() and verify the result stays within the workspace root.',
    basis: 'OWASP Node.js Security Cheat Sheet',
    expression: re("\\.\\.[\\\\/].*\\.\\.[\\\\/]|%2e%2e%2f|%2e%2e[\\\\/]|[\\/\\\\]\\.\\.[\\/\\\\]", 'g') },
]

const ANTI_ANALYSIS_RULES = [
  { id: 'MKT-ANALYZE-001', family: 'anti-analysis', risk: 'medium', confidence: 'low',
    message: 'detects debugger or analysis tool presence',
    remediation: 'Remove any anti-analysis patterns; they hinder security review.',
    basis: 'Code Analysis Anti-Patterns',
    expression: re("\\b(?:debugger|--inspect|noDebug|debugMode|isDebugging)\\b|constructor\\.constructor[^\\n]{0,100}debug", 'g') },
  { id: 'MKT-ANALYZE-002', family: 'anti-analysis', risk: 'medium', confidence: 'low',
    message: 'uses Error.stack or stack trace inspection for anti-debugging',
    remediation: 'Avoid stack-based anti-debugging techniques; they indicate malicious intent.',
    basis: 'Code Analysis Anti-Patterns',
    expression: re("Error\\s*\\(\\)\\.stack|new\\s+Error\\s*\\(\\).*\\.stack|(?:console|process)\\.trace\\s*\\(", 'g') },
]

const SUPPLY_CHAIN_RULES = [
  { id: 'MKT-SUPPLY-001', family: 'supply-chain', risk: 'high', confidence: 'high',
    message: 'declares an install-time lifecycle script (preinstall/install/postinstall/prepare)',
    remediation: 'Remove install-time side effects or document and review each lifecycle script.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: null },
  { id: 'MKT-SUPPLY-002', family: 'supply-chain', risk: 'high', confidence: 'medium',
    message: 'uses arbitrary git/URL dependency without pinned commit',
    remediation: 'Pin all dependencies to immutable commit SHAs or version ranges.',
    basis: 'OpenSSF Scorecards',
    expression: re("\\b(?:github:|git\\+|https?:\\/\\/)\\S+", 'g') },
  { id: 'MKT-SUPPLY-003', family: 'supply-chain', risk: 'medium', confidence: 'medium',
    message: 'dependencies reference a git+ URL (potential supply-chain risk)',
    remediation: 'Prefer versioned package references over git URLs for reproducible builds.',
    basis: 'OpenSSF Scorecards',
    expression: re("\"git\\+https?:\\/\\/|\"github:", 'g') },
  { id: 'MKT-MAN-001', family: 'manifest', risk: 'medium', confidence: 'high',
    message: 'package.json is not valid JSON',
    remediation: 'Publish a valid manifest so install behavior can be reviewed.',
    basis: 'OWASP npm Security Cheat Sheet',
    expression: null },
]

// ═══════════════════════════════════════════════════════════════
// Composite Rules
// ═══════════════════════════════════════════════════════════════
const COMPOSITE_RULES = [
  {
    id: 'MKT-DATA-003', family: 'data-egress', risk: 'high', confidence: 'medium',
    message: 'reads a likely secret source and opens a network connection in the same source file',
    remediation: 'Keep secrets out of agent-visible output and require an allowlisted destination before egress.',
    basis: 'OWASP MCP Security Cheat Sheet',
  },
  {
    id: 'MKT-SKILL-001', family: 'agent-skill', risk: 'high', confidence: 'medium',
    message: 'contains instruction override language together with destructive or external-action guidance',
    remediation: 'Treat external content as data; preserve approval boundaries; remove override directives.',
    basis: 'OWASP Top 10 for LLM Applications',
  },
  {
    id: 'MKT-CI-001', family: 'ci-integrity', risk: 'high', confidence: 'high',
    message: 'uses pull_request_target with a pull-request head checkout reference',
    remediation: 'Do not check out untrusted PR code in pull_request_target workflows.',
    basis: 'OpenSSF Scorecards',
  },
  {
    id: 'MKT-DATA-008', family: 'data-egress', risk: 'high', confidence: 'medium',
    message: 'reads environment secrets and makes network requests in the same file',
    remediation: 'Separate secret handling from network requests; never combine in the same code flow.',
    basis: 'OWASP npm Security Cheat Sheet',
  },
  {
    id: 'MKT-EXEC-012', family: 'execution', risk: 'high', confidence: 'medium',
    message: 'decodes obfuscated payload and executes it in the same file',
    remediation: 'Remove all decode-and-execute patterns; they are strongly correlated with malicious behavior.',
    basis: 'OWASP Node.js Security Cheat Sheet',
  },
  {
    id: 'MKT-FS-005', family: 'file-system', risk: 'high', confidence: 'medium',
    message: 'reads sensitive data and writes to external location in the same file',
    remediation: 'Separate sensitive data access from file write operations; add explicit user confirmation.',
    basis: 'OWASP Node.js Security Cheat Sheet',
  },
]

// ═══════════════════════════════════════════════════════════════
// Key Regex Patterns (built once, reused)
// ═══════════════════════════════════════════════════════════════
const DESTRUCTIVE_SYSTEM = re("\\b(?:rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+(?:\\/|~|\\$HOME|%USERPROFILE%)|Remove-Item\\b[^\\n]{0,120}-Recurse\\b[^\\n]{0,120}(?:[A-Za-z]:|\\\\\\\\)|(?:mkfs\\.(?:ext[234]|xfs|btrfs|zfs)|dd\\s+if=[^\\n]{0,80}\\bof=\\/dev\\/[srh])|(?:shutdown|reboot|poweroff|halt|init\\s+[06])\\b)", 'i')
const EXPLICIT_APPROVAL = re("\\b(?:ask_user_question|requestApproval|requires?Approval|confirm(?:ation)?|prompt_user|user_confirmation|safety_confirm)\\b", 'i')
const WORKSPACE_BOUNDARY = re("\\b(?:workspace(?:Root|Path|Dir|RootPath)?|isWithinWorkspace|path\\.resolve\\s*\\(\\s*[\"\\'`]\\/workspace|path\\.resolve\\s*\\(\\s*[\"\\'`]\\/app\\b)", 'i')
const FIXED_COMMAND = re("\\b(?:execFile(?:Sync)?|spawn(?:Sync)?|fork|execv|posix_spawn)\\s*\\(\\s*[\"\\'][^\"\\']+[\"\\']", 'i')

const EXECUTION_CALL = re("\\b(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|fork|execv|posix_spawn)\\s*\\(", 'g')
const FILE_MUTATION_CALL = re("\\b(?:writeFile|appendFile|copyFile|rename|mkdir|chmod|truncate|unlink|rm|rmdir|fs\\.promises\\.|fs\\.writeFile|fs\\.appendFile)\\s*\\(|\\b(?:Set-Content|Add-Content|Remove-Item|New-Item|Copy-Item|Move-Item)\\b", 'g')

const SECRET_SOURCE = re("\\b(?:process\\.env\\.[A-Z0-9_]*(?:API_KEY|API_SECRET|TOKEN|SECRET|PASSWORD|CREDENTIAL|CLIENT_SECRET|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY)|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|AWS_SECRET|GCP_KEY|AZURE_.*KEY)\\b|fs\\.read(?:File|FileSync)?\\s*\\([^)]*(?:passwd|shadow|\\.ssh|\\.aws|\\.docker|credentials|secret|token)", 'i')
const NETWORK_SINK = re("\\b(?:fetch|https?\\.request|WebSocket|axios|got|superagent|node-fetch|require\\s*\\(\\s*[\"\\'](?:https?|ws)[\"\\']|http\\.get)\\s*\\(", 'i')
const INSTRUCTION_OVERRIDE = re("\\b(?:ignore|override|disregard|forget|disobey|bypass|defeat)\\b[^\\n]{0,200}\\b(?:previous|system|developer|approval|sandbox|guardrail|instruction|safety|restriction|rule|policy|instructions?|prompt)\\b", 'i')
const DESTRUCTIVE_OR_EGRESS_GUIDANCE = re("\\b(?:rm\\s+-rf|git\\s+reset\\s+--hard|curl|wget|upload|webhook|pastebin|transfer\\.sh|do not ask|auto-approve|transmit|exfiltrat|leak)\\b", 'i')
const EXEC_SINK = re("\\b(?:(?:eval|Function|new\\s+Function|vm\\.run|setTimeout\\s*\\(\\s*eval|setInterval\\s*\\(\\s*eval|setImmediate\\s*\\(\\s*eval)\\s*\\(|require\\s*\\(\\s*[^)]+\\)|import\\s*\\([^)]+\\))", 'i')

// ═══════════════════════════════════════════════════════════════
// Evidence-Oriented Impact Mapping
// 每条规则的证据导向危害证明：攻击向量 + 具体危害 + CWE 编号
// ═══════════════════════════════════════════════════════════════
const IMPACT_MAP = {
  // ── 执行层 ──
  'MKT-EXEC-001': {
    impact: 'Attackers can execute arbitrary OS commands on the host, leading to full system compromise.',
    attackVector: 'Plugin spawns a child process with attacker-controlled arguments; no user approval gate.',
    cwe: 'CWE-78',
  },
  'MKT-EXEC-002': {
    impact: 'Dynamic eval/Function allows execution of arbitrary injected code, bypassing all static defenses.',
    attackVector: 'User input or fetched data flows into eval()/new Function() without sanitization.',
    cwe: 'CWE-95',
  },
  'MKT-EXEC-003': {
    impact: 'Downloading and piping remote code to an interpreter gives attackers full RCE on the CI runner.',
    attackVector: 'curl/wget output piped to bash/node/python — no checksum verification on fetched content.',
    cwe: 'CWE-494',
  },
  'MKT-EXEC-006': {
    impact: 'WebAssembly modules execute arbitrary machine code at native speed, invisible to JS-level sandboxing.',
    attackVector: 'Untrusted .wasm binary loaded via WebAssembly.instantiate() — no source verification.',
    cwe: 'CWE-94',
  },
  'MKT-EXEC-007': {
    impact: 'Native .node addons run arbitrary C++ code with full process privileges — no sandbox applies.',
    attackVector: 'process.dlopen() or require("*.node") loads a shared library with unrestricted system access.',
    cwe: 'CWE-912',
  },
  'MKT-EXEC-008': {
    impact: 'vm module bypasses Node.js sandbox isolation; attacker code runs in the main context.',
    attackVector: 'vm.runInNewContext() does not isolate — escape techniques are well-documented.',
    cwe: 'CWE-94',
  },
  'MKT-EXEC-009': {
    impact: 'Dynamic import() with variable paths allows loading arbitrary modules at runtime.',
    attackVector: 'import(variablePath) — attacker controls the path to inject malicious modules.',
    cwe: 'CWE-94',
  },
  'MKT-EXEC-010': {
    impact: 'setTimeout/setInterval with non-literal arguments can trigger delayed code execution.',
    attackVector: 'setTimeout(string) or setTimeout(variable) — eval-equivalent if string is attacker-controlled.',
    cwe: 'CWE-95',
  },
  'MKT-EXEC-012': {
    impact: 'Decoded payload executed in same file — classic obfuscation-to-RCE pattern.',
    attackVector: 'Buffer.from(base64).toString() → eval() chain; the base64 payload is invisible to static review.',
    cwe: 'CWE-94',
  },
  // ── 数据外泄 ──
  'MKT-DATA-001': {
    impact: 'Hardcoded API keys/tokens can be exfiltrated by anyone with read access to the plugin source.',
    attackVector: 'Secret key pattern matched in source — key is shipped in plaintext to all consumers.',
    cwe: 'CWE-798',
  },
  'MKT-DATA-002': {
    impact: 'Disabling TLS verification or using plaintext HTTP allows MITM interception of all traffic.',
    attackVector: 'rejectUnauthorized: false or http:// URL — attacker can intercept/modify all requests.',
    cwe: 'CWE-295',
  },
  'MKT-DATA-003': {
    impact: 'Secret source + network sink in same file = direct exfiltration pathway for credentials.',
    attackVector: 'File reads secrets (process.env/credential files) AND opens network connections — data flows out.',
    cwe: 'CWE-200',
  },
  'MKT-DATA-004': {
    impact: 'Raw TCP/UDP sockets bypass HTTP-level monitoring and allow covert data channels.',
    attackVector: 'net.connect() or dgram.createSocket() — traffic is invisible to HTTP-based DLP.',
    cwe: 'CWE-923',
  },
  'MKT-DATA-005': {
    impact: 'Environment variables often contain API keys, tokens, and database credentials.',
    attackVector: 'process.env.SECRET accessed in plugin code — if combined with network calls, secrets are exfiltrated.',
    cwe: 'CWE-532',
  },
  'MKT-DATA-006': {
    impact: 'Direct access to system credential stores allows theft of SSH keys, AWS creds, and Docker tokens.',
    attackVector: 'File path matches ~/.ssh/id_rsa, ~/.aws/credentials, or ~/.docker/config.json.',
    cwe: 'CWE-200',
  },
  'MKT-DATA-008': {
    impact: 'Environment secrets combined with network requests create a direct exfiltration channel.',
    attackVector: 'process.env.* + fetch/http.request in same file — secrets flow to external endpoints.',
    cwe: 'CWE-200',
  },
  'MKT-DATA-009': {
    impact: 'Executable code patterns in README files indicate social engineering or steganographic payloads.',
    attackVector: 'eval()/Function() with process.env in a README — disguised as documentation examples.',
    cwe: 'CWE-94',
  },
  // ── Skill 劫持 ──
  'MKT-HIJACK-001': {
    impact: 'Prompt injection can override system instructions, causing the agent to perform unauthorized actions.',
    attackVector: '"Ignore all previous instructions" pattern detected — targets LLM instruction hierarchy.',
    cwe: 'CWE-1039',
  },
  'MKT-HIJACK-004': {
    impact: 'Tool override directives bypass approval gates and redirect agent capabilities to attacker-chosen tools.',
    attackVector: '"Use exec_command instead" pattern — redirects agent from safe tools to unrestricted ones.',
    cwe: 'CWE-1039',
  },
  'MKT-HIJACK-005': {
    impact: 'Instruction override with specific goal redirection can hijack agent behavior for data theft.',
    attackVector: 'Override + goal pattern — "ignore previous, now do X" chain to redirect agent actions.',
    cwe: 'CWE-1039',
  },
  'MKT-SKILL-001': {
    impact: 'Instruction override + destructive/egress guidance = agent weaponization for data exfiltration.',
    attackVector: 'Override language paired with "upload/webhook/rm -rf" — agent is instructed to exfiltrate or destroy.',
    cwe: 'CWE-1039',
  },
  'MKT-SKILL-002': {
    impact: 'Role impersonation ("you are now system/admin") attempts to escalate agent privileges beyond its scope.',
    attackVector: 'Role-override text in skill content — bypasses safety boundaries by impersonating elevated roles.',
    cwe: 'CWE-1039',
  },
  'MKT-SKILL-003': {
    impact: 'Multi-step prompt injection chains bypass single-shot defenses by spreading the attack across steps.',
    attackVector: 'Step 1 → Step 2 → "ignore/bypass" — chains build trust before delivering the injection payload.',
    cwe: 'CWE-1039',
  },
  'MKT-SKILL-004': {
    impact: 'Exfiltration guidance targets conversation history, memory, and session data for theft.',
    attackVector: '"collect/gather/extract" + "conversation/history/memory" — instructs agent to dump sensitive context.',
    cwe: 'CWE-200',
  },
  'MKT-SKILL-005': {
    impact: 'Disabling safety features removes the last line of defense against all other attack vectors.',
    attackVector: '"disable/bypass" + "safety/guardrail/filter" — neutralizes the agent\'s own protections.',
    cwe: 'CWE-1039',
  },
  // ── 文件系统 ──
  'MKT-FS-001': {
    impact: 'Unbounded file-system mutations can overwrite critical files, install backdoors, or corrupt data.',
    attackVector: 'writeFile/mkdir/chmod without workspace boundary check — path is not validated against workspace root.',
    cwe: 'CWE-73',
  },
  'MKT-FS-002': {
    impact: 'Writing outside workspace boundaries can modify system files, SSH keys, or CI configuration.',
    attackVector: 'Path literal starts with ../ or /etc/ — escapes the workspace sandbox.',
    cwe: 'CWE-22',
  },
  'MKT-FS-003': {
    impact: 'Reading system credential files exposes SSH private keys, AWS credentials, and Docker tokens.',
    attackVector: 'File path matches /etc/passwd, ~/.ssh/id_rsa, ~/.aws/credentials — secrets are read into memory.',
    cwe: 'CWE-200',
  },
  'MKT-FS-004': {
    impact: 'Path traversal with encoded patterns (%2e%2e%2f) or nested ../.. can escape any path-based sandbox.',
    attackVector: 'URL-encoded or nested traversal sequences — bypass naive path validation that only checks single ../.',
    cwe: 'CWE-22',
  },
  'MKT-FS-005': {
    impact: 'Sensitive data read + external file write = data staging for later exfiltration.',
    attackVector: 'Read secret → write to external path — data is copied to a location accessible to other processes.',
    cwe: 'CWE-200',
  },
  // ── 供应链 ──
  'MKT-SUPPLY-001': {
    impact: 'Install-time lifecycle scripts execute with full npm privileges — preinstall RCE is a classic attack.',
    attackVector: 'package.json scripts.preinstall/install/postinstall/prepare — runs arbitrary code during npm install.',
    cwe: 'CWE-506',
  },
  'MKT-SUPPLY-002': {
    impact: 'Unpinned git/URL dependencies allow attackers to publish malicious versions at any time.',
    attackVector: 'Dependency resolves to a mutable ref (branch/tag) — attacker pushes a malicious commit to the ref.',
    cwe: 'CWE-494',
  },
  // ── CI 完整性 ──
  'MKT-CI-001': {
    impact: 'pull_request_target + PR head checkout = arbitrary code execution in the privileged CI context.',
    attackVector: 'Workflow checks out github.event.pull_request.head.sha under pull_request_target — PR code gets GITHUB_TOKEN.',
    cwe: 'CWE-250',
  },
  'MKT-CI-002': {
    impact: 'Excessive token permissions allow the workflow to modify repository settings, push code, or access secrets.',
    attackVector: 'permissions: contents:write / workflows:write / secrets:write — grants more than needed.',
    cwe: 'CWE-250',
  },
  'MKT-CI-003': {
    impact: 'Checkout without persist-credentials: false leaves GITHUB_TOKEN in .git/config for any process to read.',
    attackVector: 'actions/checkout defaults to persist-credentials: true — token leaks via .git/config.',
    cwe: 'CWE-200',
  },
  'MKT-CI-005': {
    impact: 'curl/wget piped to interpreter fetches and executes arbitrary remote code without verification.',
    attackVector: 'curl ... | bash pattern — no checksum, no GPG verification, attacker controls the server.',
    cwe: 'CWE-494',
  },
  'MKT-CI-006': {
    impact: 'pull_request_target grants token access to PR code — even without head checkout, other injection paths exist.',
    attackVector: 'pull_request_target runs in a privileged context; any script injection in PR body can exploit it.',
    cwe: 'CWE-250',
  },
  'MKT-CI-007': {
    impact: 'Wildcard (*) token permission grants every available scope — maximum privilege exposure.',
    attackVector: 'permissions: *: write — workflow can push code, modify workflows, and read all secrets.',
    cwe: 'CWE-250',
  },
  'MKT-CI-008': {
    impact: 'Downloading scripts without integrity verification allows MITM substitution of malicious code.',
    attackVector: 'curl/wget in workflow without checksum/sha256 verification — attacker intercepts and replaces.',
    cwe: 'CWE-494',
  },
  // ── 持久化 ──
  'MKT-PERSIST-001': {
    impact: 'Lifecycle hooks (install/uninstall/activate) create persistence — malicious code runs across sessions.',
    attackVector: 'Plugin registers install/activate handlers that modify the host environment on load.',
    cwe: 'CWE-506',
  },
  'MKT-PERSIST-002': {
    impact: 'Writing to startup files (~/.bashrc, ~/.zshrc) ensures malicious code runs on every shell session.',
    attackVector: 'File write to shell rc files — persistence across reboots and new terminals.',
    cwe: 'CWE-506',
  },
  // ── 反分析 ──
  'MKT-ANALYZE-001': {
    impact: 'Anti-debugging patterns indicate the code is designed to evade security review.',
    attackVector: 'debugger statement or --inspect detection — code changes behavior when being analyzed.',
    cwe: 'CWE-506',
  },
  'MKT-ANALYZE-002': {
    impact: 'Stack trace inspection for anti-debugging allows code to detect and evade analysis tools.',
    attackVector: 'Error().stack inspection — detects if running in a debugger/analysis environment.',
    cwe: 'CWE-506',
  },
  // ── 混淆 ──
  'MKT-REVIEW-005': {
    impact: 'Extremely long lines hide obfuscated or minified code from human review.',
    attackVector: 'Lines > 500 chars — code is structured to evade visual inspection.',
    cwe: 'CWE-506',
  },
}

// ═══════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════
function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length
}

function extractSnippet(text, offset, radius = 60) {
  const start = Math.max(0, offset - radius)
  const end = Math.min(text.length, offset + radius)
  let snippet = text.slice(start, end).replace(/\n/g, ' ').trim()
  if (start > 0) snippet = '...' + snippet
  if (end < text.length) snippet = snippet + '...'
  return snippet.slice(0, 160)
}

function assessEvidenceStrength(matchedText, rule, context = {}) {
  let strength = rule.confidence || 'medium'
  if (!matchedText) return strength
  const lower = matchedText.toLowerCase()
  // High-strength indicators: explicit dangerous function calls
  const highStrength = [
    /eval\s*\(/, /exec(?:sync)?\s*\(/, /spawn\s*\(/, /child_process/,
    /rm\s+-rf/, /\.ssh\/id_rsa/, /\/etc\/passwd/, /webhook\.site/,
    /pastebin/, /transfer\.sh/, /base64/i, /atob\(/,
    /process\.dlopen/, /WebAssembly\.(?:instantiate|compile)/,
    /pull_request_target/, /persist-credentials/,
  ]
  // Low-strength indicators: common patterns that may be benign
  const lowStrength = [
    /require\s*\(\s*['"]\.\/|^import\s/m, /console\./, /test/i,
    /mock/i, /example/i, /documentation/i, /readme/i,
  ]
  for (const p of highStrength) {
    if (p.test(lower)) { strength = 'high'; break }
  }
  for (const p of lowStrength) {
    if (p.test(lower)) { strength = strength === 'high' ? 'medium' : 'low'; break }
  }
  // If composite context has both sides, boost to high
  if (context.composite && context.composite.length >= 2) strength = 'high'
  return strength
}

function evidenceBasedRisk(rule, matchedText, context = {}) {
  const strength = assessEvidenceStrength(matchedText, rule, context)
  // Evidence confidence describes a static lead. It must not lower risk on its
  // own: only the explicit write/exec protection model may do that.
  return {
    risk: rule.risk,
    evidenceConfidence: strength,
    adjustment: 'No automatic downgrade: risk changes require explicit protective controls.',
  }
}

function makeFinding(rule, file, line, message = rule.message, details = {}) {
  const impactInfo = IMPACT_MAP[rule.id] || {}
  const evidence = details.evidence || null
  const evRisk = evidenceBasedRisk(rule, evidence, details.composite ? { composite: details.composite } : {})
  return {
    rule: rule.id,
    family: rule.family,
    risk: evRisk.risk,
    evidence_risk: rule.risk,
    confidence: rule.confidence,
    evidence_confidence: evRisk.evidenceConfidence,
    risk_adjustment: evRisk.adjustment,
    disposition: rule.disposition ?? 'manual-review',
    basis: rule.basis,
    impact: impactInfo.impact || null,
    attack_vector: impactInfo.attackVector || null,
    cwe: impactInfo.cwe || null,
    evidence,
    remediation: rule.remediation,
    file,
    line,
    message,
    ...(() => { const { evidence: _e, composite: _c, ...rest } = details; return rest })(),
  }
}

function extractURLs(text) {
  const urls = []
  const urlRegex = re("(?:https?|wss?|ftp):\\/\\/[^\\s\"'`<>`)]+", 'g')
  let m
  while ((m = urlRegex.exec(text)) !== null) {
    urls.push(m[0])
  }
  return urls
}

function isSuspiciousURL(url) {
  return SUSPICIOUS_DOMAINS.some((domain) => new RegExp(domain, 'i').test(url))
}

function containsEnvAccess(text) {
  return ENV_SENSITIVE_PATTERNS.some((p) => p.test(text))
}

function countLongLines(text, threshold = 500) {
  return text.split('\n').filter((line) => line.length > threshold).length
}

// ═══════════════════════════════════════════════════════════════
// Detection Helpers
// ═══════════════════════════════════════════════════════════════
function runRegexRule(rule, text, file, findings) {
  if (!rule.expression) return 0
  let count = 0
  rule.expression.lastIndex = 0
  for (;;) {
    const match = rule.expression.exec(text)
    if (match === null || count >= MAX_MATCHES_PER_RULE_FILE) break
    const snippet = extractSnippet(text, match.index)
    findings.push(makeFinding(rule, file, lineOf(text, match.index), rule.message, { evidence: snippet }))
    count += 1
  }
  return count
}

function runKeyDetection(text, file, findings) {
  const found = []
  for (const pattern of SECRET_KEY_PATTERNS) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(text)) !== null && found.length < MAX_MATCHES_PER_RULE_FILE) {
      found.push(m[0].slice(0, 80))
    }
  }
  if (found.length > 0) {
    findings.push(makeFinding(DATA_EGRESS_RULES[0], file, 1,
      `contains ${found.length} potential credential/key pattern(s)`,
      { evidence: 'Credential-like values redacted by the scanner.' }))
  }
  return found.length
}

function runSuspiciousDestDetection(text, file, findings) {
  const urls = extractURLs(text)
  const suspicious = urls.filter(isSuspiciousURL)
  if (suspicious.length > 0) {
    findings.push(makeFinding(DATA_EGRESS_RULES.find((rule) => rule.id === 'MKT-DATA-007'), file, 1,
      `references ${suspicious.length} known high-risk or anonymous destination(s)`,
      { evidence: 'Destination values are omitted from public evidence.' }))
  }
  return suspicious.length
}

function runEnvSecretDetection(text, file, findings) {
  const hasEnv = containsEnvAccess(text)
  const hasNetwork = NETWORK_SINK.test(text)
  let envEvidence = null
  for (const p of ENV_SENSITIVE_PATTERNS) {
    p.lastIndex = 0
    const m = p.exec(text)
    if (m) { envEvidence = m[0].slice(0, 80); break }
  }
  NETWORK_SINK.lastIndex = 0
  const netMatch = NETWORK_SINK.exec(text)
  const netEvidence = netMatch ? extractSnippet(text, netMatch.index) : null
  if (hasEnv && hasNetwork) {
    findings.push(makeFinding({
      id: 'MKT-DATA-005', family: 'data-egress', risk: 'high', confidence: 'medium',
      disposition: 'manual-review', basis: 'OWASP npm Security Cheat Sheet',
      remediation: 'Never read sensitive environment variables and transmit them over the network.',
      message: 'reads sensitive environment variables and makes network requests (potential secret exfiltration)',
    }, file, 1, undefined, {
      evidence: `ENV: ${envEvidence} | NETWORK: ${netEvidence}`,
      composite: [envEvidence, netEvidence],
    }))
  }
  return hasEnv && hasNetwork
}

function runLongLineDetection(text, file, findings) {
  const count = countLongLines(text, 500)
  if (count > 0) {
    const longLine = text.split('\n').find((l) => l.length > 500)
    findings.push(makeFinding(OBFUSCATION_RULES[4], file, 1,
      `contains ${count} line(s) longer than 500 characters (possible minified/obfuscated code)`,
      { evidence: longLine ? longLine.slice(0, 160) + '...' : null }))
  }
  return count
}

function runCapabilityAnalysis(text, file, findings) {
  if (TEST_PATH.test(file)) return

  const destructive = DESTRUCTIVE_SYSTEM.test(text)
  const approved = EXPLICIT_APPROVAL.test(text)

  const ruleDefs = [
    { rule: { id: 'MKT-EXEC-001', family: 'execution', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Require explicit user approval and use a fixed allowlisted command with bounded arguments.', message: 'invokes an operating-system process API' }, expr: EXECUTION_CALL, boundary: FIXED_COMMAND },
    { rule: { id: 'MKT-FS-001', family: 'file-system', risk: 'high', confidence: 'medium', disposition: 'manual-review', basis: 'OWASP Node.js Security Cheat Sheet', remediation: 'Require explicit user approval and restrict mutations to an allowlisted workspace path.', message: 'invokes a file-system mutation API' }, expr: FILE_MUTATION_CALL, boundary: WORKSPACE_BOUNDARY },
  ]

  for (const { rule, expr, boundary } of ruleDefs) {
    expr.lastIndex = 0
    let matches = 0
    for (;;) {
      const match = expr.exec(text)
      if (match === null || matches >= MAX_MATCHES_PER_RULE_FILE) break

      let risk = 'high'
      let downgrade = 'No downgrade: a system-impact pattern is present in the same source file.'
      const localProtections = []
      const constrained = boundary.test(text)

      if (!destructive) {
        risk = 'medium'
        downgrade = 'Downgraded from high: no system-impact pattern matched.'
        if (approved && constrained) {
          risk = 'low'
          const p1 = rule.id === 'MKT-EXEC-001' ? 'fixed command target' : 'workspace path boundary'
          localProtections.push('explicit user approval', p1)
          downgrade = `Downgraded from high: ${localProtections.join(' and ')} detected.`
        } else {
          if (approved) localProtections.push('explicit user approval')
          if (constrained) localProtections.push(rule.id === 'MKT-EXEC-001' ? 'fixed command target' : 'workspace path boundary')
        }
      }

      findings.push(makeFinding(rule, file, lineOf(text, match.index), rule.message, {
        evidence: extractSnippet(text, match.index),
        risk, baselineRisk: 'high',
        protections: localProtections.join(', '),
        downgrade,
      }))
      matches += 1
    }
  }
}

function runCompositeDetection(text, file, findings, fileContext) {
  const { isCode, isSkill, isWorkflow, isReadme } = fileContext
  const isMarkdown = /\.md$/i.test(file)

  // Secret exfiltration in code
  if (isCode) {
    SECRET_SOURCE.lastIndex = 0
    const secretMatch = SECRET_SOURCE.exec(text)
    NETWORK_SINK.lastIndex = 0
    const netMatch = NETWORK_SINK.exec(text)
    if (secretMatch && netMatch) {
      findings.push(makeFinding(COMPOSITE_RULES[0], file, lineOf(text, secretMatch.index), undefined, {
        evidence: `SECRET: ${extractSnippet(text, secretMatch.index)} | NETWORK: ${extractSnippet(text, netMatch.index)}`,
        composite: [extractSnippet(text, secretMatch.index), extractSnippet(text, netMatch.index)],
      }))
    }
  }

  // Instruction override + destructive/egress guidance
  if (isSkill) {
    INSTRUCTION_OVERRIDE.lastIndex = 0
    const overrideMatch = INSTRUCTION_OVERRIDE.exec(text)
    DESTRUCTIVE_OR_EGRESS_GUIDANCE.lastIndex = 0
    const egressMatch = DESTRUCTIVE_OR_EGRESS_GUIDANCE.exec(text)
    if (overrideMatch && egressMatch) {
      findings.push(makeFinding(COMPOSITE_RULES[1], file, lineOf(text, overrideMatch.index),
        'skill file contains instruction override with destructive or egress guidance', {
          evidence: `OVERRIDE: ${extractSnippet(text, overrideMatch.index)} | EGRESS: ${extractSnippet(text, egressMatch.index)}`,
          composite: [extractSnippet(text, overrideMatch.index), extractSnippet(text, egressMatch.index)],
        }))
    }
  }

  // Dangerous CI workflow
  if (isWorkflow) {
    if (/\bpull_request_target\b/.test(text) && /github\.event\.pull_request\.head\.(?:sha|ref)/.test(text)) {
      findings.push(makeFinding(COMPOSITE_RULES[2], file, 1, undefined, {
        evidence: 'pull_request_target + github.event.pull_request.head.sha/ref detected in workflow',
        composite: ['pull_request_target', 'github.event.pull_request.head.*'],
      }))
    }
  }

  // Env secret + network
  if (isCode && containsEnvAccess(text) && NETWORK_SINK.test(text)) {
    let envM = null
    for (const p of ENV_SENSITIVE_PATTERNS) {
      p.lastIndex = 0
      const m = p.exec(text)
      if (m) { envM = m[0].slice(0, 80); break }
    }
    NETWORK_SINK.lastIndex = 0
    const netM = NETWORK_SINK.exec(text)
    findings.push(makeFinding(COMPOSITE_RULES[3], file, 1, undefined, {
      evidence: `ENV: ${envM || 'matched'} | NETWORK: ${netM ? extractSnippet(text, netM.index) : 'matched'}`,
      composite: [envM, netM ? extractSnippet(text, netM.index) : null],
    }))
  }

  // Decode + execute
  const decodeRe = re("\\b(?:atob|Buffer\\.from|TextDecoder)\\s*\\(", 'g')
  if (isCode) {
    decodeRe.lastIndex = 0
    const decodeMatch = decodeRe.exec(text)
    EXEC_SINK.lastIndex = 0
    const execMatch = EXEC_SINK.exec(text)
    if (decodeMatch && execMatch) {
      findings.push(makeFinding(COMPOSITE_RULES[4], file, lineOf(text, decodeMatch.index), undefined, {
        evidence: `DECODE: ${extractSnippet(text, decodeMatch.index)} | EXEC: ${extractSnippet(text, execMatch.index)}`,
        composite: [extractSnippet(text, decodeMatch.index), extractSnippet(text, execMatch.index)],
      }))
    }
  }

  // Sensitive read + file write
  const sensitivePath = re("\\/etc\\/(?:passwd|shadow|hosts)|\\.ssh[\\/\\\\]id_|\\.aws[\\/\\\\]credentials", 'g')
  const fileWriteSink = re("\\b(?:writeFile|appendFile|fs\\.writeFile)\\s*\\(", 'g')
  if (isCode) {
    sensitivePath.lastIndex = 0
    const sensMatch = sensitivePath.exec(text)
    fileWriteSink.lastIndex = 0
    const writeMatch = fileWriteSink.exec(text)
    if (sensMatch && writeMatch) {
      findings.push(makeFinding(COMPOSITE_RULES[5], file, lineOf(text, sensMatch.index), undefined, {
        evidence: `READ: ${extractSnippet(text, sensMatch.index)} | WRITE: ${extractSnippet(text, writeMatch.index)}`,
        composite: [extractSnippet(text, sensMatch.index), extractSnippet(text, writeMatch.index)],
      }))
    }
  }
}

function scanManifest(manifest, file, findings) {
  const scripts = manifest?.scripts
  if (scripts && typeof scripts === 'object') {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (typeof scripts[name] === 'string' && scripts[name].trim() !== '') {
        const rule = name === 'prepare'
          ? { ...SUPPLY_CHAIN_RULES[0], risk: 'medium', confidence: 'medium' }
          : SUPPLY_CHAIN_RULES[0]
        findings.push(makeFinding(rule, file, 1,
          `declares a ${name} lifecycle script`,
          { evidence: 'Lifecycle command omitted from public evidence.' }))
      }
    }
    if (manifest.dependencies) {
      for (const [pkg, spec] of Object.entries(manifest.dependencies)) {
        if (typeof spec === 'string' && /^(git\+https?:\/\/|github:)/.test(spec)) {
          findings.push(makeFinding(SUPPLY_CHAIN_RULES[2], file, 1,
            `dependency ${pkg} uses a git URL`,
            { evidence: 'Dependency URL omitted from public evidence.' }))
        }
      }
    }
    if (manifest.devDependencies) {
      for (const [pkg, spec] of Object.entries(manifest.devDependencies)) {
        if (typeof spec === 'string' && /^(git\+https?:\/\/|github:)/.test(spec)) {
          findings.push(makeFinding(SUPPLY_CHAIN_RULES[2], file, 1,
            `devDependency ${pkg} uses a git URL`,
            { evidence: 'Dependency URL omitted from public evidence.' }))
        }
      }
    }
  }
}

function checkWorkflowIntegrity(text, file, findings) {
  if (!WORKFLOW_FILE.test(file)) return

  if (/\bpull_request_target\b/.test(text)) {
    const dangerousPattern = /github\.event\.pull_request\.head\.(?:sha|ref)|\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)\s*\}\}/
    if (dangerousPattern.test(text)) {
      const dMatch = dangerousPattern.exec(text)
      findings.push(makeFinding(CI_INTEGRITY_RULES[0], file, 1, undefined, {
        evidence: `pull_request_target + ${dMatch ? dMatch[0] : 'github.event.pull_request.head.*'}`,
        composite: ['pull_request_target', dMatch ? dMatch[0] : 'github.event.pull_request.head.*'],
      }))
    } else {
      findings.push(makeFinding({
        id: 'MKT-CI-006', family: 'ci-integrity', risk: 'medium', confidence: 'medium',
        message: 'uses pull_request_target — verify no head SHA/ref is checked out',
        remediation: 'Ensure pull_request_target does not access github.event.pull_request.head.*',
        basis: 'OpenSSF Scorecards', disposition: 'manual-review',
      }, file, 1, undefined, { evidence: 'pull_request_target detected (no head.* checkout found, but still risky)' }))
    }
  }

  const permMatch = /permissions:[\s\S]{0,300}/i.exec(text)
  if (permMatch) {
    const permText = permMatch[0]
    const dangerousPerms = []
    if (/workflows?\s*:\s*(?:write|admin)/i.test(permText)) dangerousPerms.push('workflows:write')
    if (/secrets\s*:\s*(?:write|admin)/i.test(permText)) dangerousPerms.push('secrets:write')
    if (dangerousPerms.length > 0) {
      findings.push(makeFinding(CI_INTEGRITY_RULES[1], file, 1,
        `excessive GitHub token permissions: ${dangerousPerms.join(', ')}`,
        { evidence: permText.slice(0, 160).replace(/\s+/g, ' ') }))
    }
    if (/\*\s*:\s*(?:write|admin)/.test(permText)) {
      findings.push(makeFinding({
        id: 'MKT-CI-007', family: 'ci-integrity', risk: 'high', confidence: 'high',
        message: 'uses wildcard (*) GitHub token permission — grants all permissions',
        remediation: 'Replace wildcard permissions with the minimum required scopes.',
        basis: 'OpenSSF Scorecards', disposition: 'manual-review',
      }, file, 1, undefined, { evidence: permText.slice(0, 160).replace(/\s+/g, ' ') }))
    }
  }

  if (/actions\/checkout[^\\n]{0,100}(?!persist-credentials[^\\n]{0,50}false)/i.test(text)) {
    const unsafeCheckout = /actions\/checkout[^\\n]{0,100}/i.exec(text)
    if (unsafeCheckout && /persist-credentials[^\\n]{0,50}false/i.test(unsafeCheckout[0]) === false) {
      findings.push(makeFinding(CI_INTEGRITY_RULES[2], file, 1,
        'checkout without persist-credentials: false — tokens may leak',
        { evidence: unsafeCheckout[0].slice(0, 160) }))
    }
  }

  if (/curl|wget|powershell.*download/i.test(text)) {
    const hasVerification = /(?:checksum|sha256|gpg|signature|verify|hash)/i.test(text)
    if (!hasVerification) {
      const dlMatch = /(?:curl|wget|powershell.*download)[^\\n]{0,80}/i.exec(text)
      findings.push(makeFinding({
        id: 'MKT-CI-008', family: 'ci-integrity', risk: 'medium', confidence: 'low',
        message: 'workflow downloads remote scripts without integrity verification',
        remediation: 'Add checksum/GPG verification for all downloaded artifacts.',
        basis: 'OpenSSF Scorecards', disposition: 'manual-review',
      }, file, 1, undefined, { evidence: dlMatch ? dlMatch[0].slice(0, 120) : 'download pattern detected' }))
    }
  }
}

function checkReadmeSecurity(text, file, findings) {
  if (!README_FILE.test(file)) return
  if (/\b(?:eval|Function)\s*\(/.test(text) && /process\.env/.test(text)) {
    findings.push(makeFinding({
      id: 'MKT-DATA-009', family: 'data-egress', risk: 'medium', confidence: 'low',
      disposition: 'manual-review', basis: 'OWASP npm Security Cheat Sheet',
      remediation: 'README files should contain documentation only; executable code patterns are suspicious.',
      message: 'README contains executable patterns with environment variable access',
    }, file, 1))
  }
}

// ═══════════════════════════════════════════════════════════════
// Core Scanner
// ═══════════════════════════════════════════════════════════════
function rank(risk) {
  return risk === 'high' ? 3 : risk === 'medium' ? 2 : risk === 'low' ? 1 : 0
}

function riskFrom(findings) {
  let highest = 'low'
  for (const finding of findings) {
    if (rank(finding.risk) > rank(highest)) highest = finding.risk
  }
  return highest
}

function statusFrom(risk) {
  // Receipt consumers accept passed, warnings, and incomplete. The risk field
  // carries the severity; a static advisory never claims a runtime failure.
  return risk === 'low' ? 'passed' : 'warnings'
}

function computeRiskScore(findings, stats) {
  let score = 0
  const weights = {
    critical: 25, high: 12, medium: 5, low: 1,  // critical kept for score calc only, not emitted in findings
  }
  const familyBoost = {
    'execution': 8, 'data-egress': 6, 'agent-skill': 7,
    'file-system': 5, 'ci-integrity': 6, 'anti-analysis': 4,
    'supply-chain': 3, 'obfuscation': 2,
  }
  for (const f of findings) {
    score += weights[f.risk] ?? 1
    score += familyBoost[f.family] ?? 0
  }
  if (stats?.secretsFound > 0) score += stats.secretsFound * 10
  if (stats?.suspiciousURLs > 0) score += stats.suspiciousURLs * 5
  if (stats?.skillHijackPatterns > 10) score += 15
  return Math.min(score, 100)
}

function riskGrade(score) {
  if (score >= 70) return { grade: 'F', label: 'high', color: '#dc2626' }
  if (score >= 55) return { grade: 'D', label: 'high', color: '#ea580c' }
  if (score >= 35) return { grade: 'C', label: 'medium', color: '#ca8a04' }
  if (score >= 15) return { grade: 'B', label: 'low', color: '#16a34a' }
  return { grade: 'A', label: 'minimal', color: '#2563eb' }
}

function rankingSummary(receipt) {
  const score = computeRiskScore(receipt.findings, receipt.stats)
  const { grade, label, color } = riskGrade(score)
  const byFamily = {}
  for (const f of receipt.findings) {
    byFamily[f.family] = (byFamily[f.family] || 0) + 1
  }
  const familyList = Object.entries(byFamily)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
  return { score, grade, label, color, familyBreakdown: familyList }
}

function likelyText(buffer) {
  return buffer.length > 0 && !buffer.includes(0)
}

async function sourceFiles(root) {
  const files = []
  const seen = new Set()
  let truncated = false

  async function visit(directory, depth = 0) {
    if (files.length >= MAX_FILES) { truncated = true; return }
    if (depth > 20) return

    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return }
      const fullPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(fullPath, depth + 1)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        const isText = TEXT_EXTENSIONS.has(ext) || entry.name === 'package.json'
        if (!isText || seen.has(fullPath)) continue
        seen.add(fullPath)
        try {
          const info = await stat(fullPath)
          if (info.size <= MAX_FILE_BYTES) files.push(fullPath)
          else truncated = true
        } catch {}
      }
    }
  }
  await visit(root)
  return { files, truncated }
}

export async function scanPluginSource(root, { commit = null, repository = null } = {}) {
  const { files, truncated: sourceTruncated } = await sourceFiles(root)
  const findings = []
  const stats = {
    filesScanned: 0, filesSkipped: 0,
    execPatterns: 0, dataEgressPatterns: 0, persistencePatterns: 0,
    obfuscationPatterns: 0, skillHijackPatterns: 0, ciIntegrityPatterns: 0,
    filesystemPatterns: 0, supplyChainPatterns: 0,
    longLines: 0, secretsFound: 0, suspiciousURLs: 0,
  }

  for (const filePath of files) {
    if (findings.length >= MAX_FINDINGS) break

    let body
    try { body = await readFile(filePath) } catch { continue }
    if (!likelyText(body)) { stats.filesSkipped += 1; continue }

    const text = body.toString('utf8')
    const display = relative(root, filePath).replaceAll('\\', '/')
    const ext = extname(display).toLowerCase()
    const isCode = CODE_EXTENSIONS.has(ext)
    const isManifest = MANIFEST_FILE.test(display)
    const isWorkflow = WORKFLOW_FILE.test(display)
    const isSkill = SKILL_FILE.test(display)
    const isReadme = README_FILE.test(display)
    const isProductionCode = isCode && !TEST_PATH.test(display)
    const isSecuritySource = isProductionCode || isManifest || isSkill || isWorkflow
    const isCredentialSource = isProductionCode || isManifest

    stats.filesScanned += 1

    if (isManifest) {
      try {
        scanManifest(JSON.parse(text.replace(/^\uFEFF/, '')), display, findings)
      } catch {
        findings.push(makeFinding(SUPPLY_CHAIN_RULES[3], display, 1))
      }
    }

    if (isSecuritySource) stats.longLines += runLongLineDetection(text, display, findings)
    if (isWorkflow) checkWorkflowIntegrity(text, display, findings)
    if (isProductionCode) stats.suspiciousURLs += runSuspiciousDestDetection(text, display, findings)
    if (isCredentialSource) stats.secretsFound += runKeyDetection(text, display, findings)
    if (isProductionCode) runEnvSecretDetection(text, display, findings)
    if (isProductionCode) runCapabilityAnalysis(text, display, findings)

    runCompositeDetection(text, display, findings, { isCode: isProductionCode, isSkill, isWorkflow, isReadme })

    if (isProductionCode) {
      for (const rule of EXECUTION_RULES) stats.execPatterns += runRegexRule(rule, text, display, findings)
      for (const rule of DATA_EGRESS_RULES.filter(r => r.expression)) stats.dataEgressPatterns += runRegexRule(rule, text, display, findings)
      for (const rule of PERSISTENCE_RULES) stats.persistencePatterns += runRegexRule(rule, text, display, findings)
      for (const rule of OBFUSCATION_RULES.filter(r => r.expression)) stats.obfuscationPatterns += runRegexRule(rule, text, display, findings)
      for (const rule of ANTI_ANALYSIS_RULES) stats.obfuscationPatterns += runRegexRule(rule, text, display, findings)
      for (const rule of FILESYSTEM_RULES.filter(r => r.expression)) stats.filesystemPatterns += runRegexRule(rule, text, display, findings)
    }

    if (isSkill) {
      for (const rule of SKILL_HIJACK_RULES.filter(r => r.expression)) stats.skillHijackPatterns += runRegexRule(rule, text, display, findings)
    }
  }

  const risk = riskFrom(findings)
  const truncated = sourceTruncated || findings.length >= MAX_FINDINGS
  const ranking = rankingSummary({ findings, stats })

  return {
    format: FORMAT, kind: 'static-security', repository, commit,
    checkedAt: new Date().toISOString(),
    scannerVersion: SCANNER_VERSION, rulesetVersion: RULESET_VERSION,
    status: truncated ? 'incomplete' : statusFrom(risk),
    risk, riskScore: ranking.score, riskGrade: ranking.grade,
    riskLabel: ranking.label, familyBreakdown: ranking.familyBreakdown,
    scannedFiles: stats.filesScanned, skippedFiles: stats.filesSkipped,
    findings, truncated, stats,
  }
}

// ═══════════════════════════════════════════════════════════════
// Receipt Validation
// ═══════════════════════════════════════════════════════════════
export function readCompatibilityAttestation(value, commit, repository = null) {
  if (!value || typeof value !== 'object') return null
  if (value.format !== FORMAT || value.kind !== 'baseline-compatibility') return null
  if (value.commit !== commit || value.result !== 'passed' || value.profileMode !== 'clean') return null
  if (repository !== null && value.repository !== repository) return null
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null
  if (!value.plugin || typeof value.plugin !== 'object' || !/^[a-f0-9]{64}$/i.test(value.plugin.sourceFingerprint ?? '')) return null
  return {
    format: FORMAT, kind: 'baseline-compatibility',
    repository: repository ?? value.repository ?? null, commit,
    checkedAt: value.checkedAt, status: 'passed', profileMode: 'clean',
    pluginName: typeof value.plugin.name === 'string' ? value.plugin.name : null,
    sourceFingerprint: value.plugin.sourceFingerprint,
  }
}

export async function validateCompatibilityAttestationForSource(root, value, commit, repository = null) {
  const attestation = readCompatibilityAttestation(value, commit, repository)
  if (attestation === null) return null
  try {
    const manifestText = await readFile(join(root, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''))
    if (typeof manifest?.name !== 'string' || manifest.name !== attestation.pluginName) return null
    const fingerprint = createHash('sha256').update(manifestText).digest('hex')
    if (fingerprint !== attestation.sourceFingerprint) return null
  } catch { return null }
  const { pluginName, sourceFingerprint, ...portable } = attestation
  return portable
}

export function formatCheckMarker(receipt) {
  return `<!-- dsh-plugin-verification:${JSON.stringify(receipt)} -->`
}

export { computeRiskScore, riskGrade, rankingSummary }

// ═══════════════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════════════
function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name) {
  return process.argv.includes(name)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = arg('--path') ?? process.cwd()
  const commit = arg('--commit') ?? process.env.GITHUB_SHA ?? null
  const repository = arg('--repository') ?? process.env.GITHUB_REPOSITORY ?? null
  const out = arg('--out')
  const rankingMode = hasFlag('--ranking')
  const compatibilityPath = arg('--compatibility')
  const receipt = await scanPluginSource(root, { commit, repository })

  if (compatibilityPath !== undefined) {
    try {
      const compatText = await readFile(compatibilityPath, 'utf8')
      const compatibility = await validateCompatibilityAttestationForSource(root, JSON.parse(compatText), commit, repository)
      if (compatibility !== null) receipt.publisherCompatibility = compatibility
    } catch {}
  }

  if (out !== undefined) {
    await writeFile(out, JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  }

  if (rankingMode) {
    const r = {
      repository: receipt.repository,
      commit: receipt.commit,
      score: receipt.riskScore,
      grade: receipt.riskGrade,
      risk: receipt.risk,
      findings: receipt.findings.length,
      files: receipt.scannedFiles,
      families: receipt.familyBreakdown,
    }
    console.log(JSON.stringify(r))
  } else {
    console.log(formatCheckMarker(receipt))
    console.log(`static security: ${receipt.status}, risk=${receipt.risk}, score=${receipt.riskScore} (${receipt.riskGrade}), findings=${receipt.findings.length}, files=${receipt.scannedFiles}`)
    if (receipt.familyBreakdown?.length) {
      console.log(`  families: ${receipt.familyBreakdown.join(', ')}`)
    }
    if (receipt.stats) {
      const s = receipt.stats
      console.log(`  stats: exec=${s.execPatterns} egress=${s.dataEgressPatterns} persistence=${s.persistencePatterns}`)
      console.log(`         obfuscation=${s.obfuscationPatterns} skill=${s.skillHijackPatterns} ci=${s.ciIntegrityPatterns}`)
      console.log(`         fs=${s.filesystemPatterns} supply=${s.supplyChainPatterns} secrets=${s.secretsFound} urls=${s.suspiciousURLs}`)
    }
  }
}