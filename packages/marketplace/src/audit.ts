/**
 * DSH Marketplace Security & Permission Static Scanner
 * 
 * Inspects plugin / MCP adapter metadata and declares capability permissions
 * (filesystem, shell execution, network egress, env access) before installation.
 */

export interface PermissionReport {
  packageName: string;
  riskLevel: 'low' | 'medium' | 'high';
  declaredCapabilities: string[];
  findings: string[];
}

const HIGH_RISK_PATTERNS = [
  { pattern: /child_process|exec|spawn|sudo|shell/i, capability: 'shell:exec', risk: 'high' as const, desc: 'Arbitrary shell execution capability' },
  { pattern: /fs\.unlink|fs\.rm|fs\.rmdir|destructive|delete/i, capability: 'fs:destructive', risk: 'high' as const, desc: 'Destructive filesystem deletion capability' },
  { pattern: /fetch|axios|http|https|net\.connect|curl|network/i, capability: 'net:egress', risk: 'medium' as const, desc: 'External network egress' },
  { pattern: /process\.env|token|key|credential/i, capability: 'env:read', risk: 'low' as const, desc: 'Environment/Credential access' }
];

export function auditPluginSecurity(packageName: string, description: string = '', keywords: string[] = []): PermissionReport {
  const text = `${packageName} ${description} ${keywords.join(' ')}`;
  const capabilities: string[] = [];
  const findings: string[] = [];
  let maxRisk: 'low' | 'medium' | 'high' = 'low';

  for (const item of HIGH_RISK_PATTERNS) {
    if (item.pattern.test(text)) {
      capabilities.push(item.capability);
      findings.push(item.desc);
      if (item.risk === 'high') {
        maxRisk = 'high';
      } else if (item.risk === 'medium' && maxRisk !== 'high') {
        maxRisk = 'medium';
      }
    }
  }

  if (capabilities.length === 0) {
    capabilities.push('standard:sandboxed');
    findings.push('No elevated system privileges requested');
  }

  return {
    packageName,
    riskLevel: maxRisk,
    declaredCapabilities: capabilities,
    findings
  };
}
