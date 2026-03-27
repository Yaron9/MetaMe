'use strict';

const VALID_TEAM_COLORS = ['green', 'yellow', 'red', 'blue', 'purple', 'orange', 'pink', 'indigo'];

function parseTeamMembers(input, teamName) {
  const memberLines = String(input || '').split(/[,，\n]/).filter(line => line.trim());
  const members = [];

  for (const line of memberLines) {
    const parts = line.trim().split(':');
    const name = parts[0] && parts[0].trim();
    if (!name) continue;

    const icon = (parts[1] && parts[1].trim()) || '🤖';
    const rawColor = parts[2] && parts[2].trim().toLowerCase();
    const color = VALID_TEAM_COLORS.includes(rawColor)
      ? rawColor
      : VALID_TEAM_COLORS[members.length % VALID_TEAM_COLORS.length];

    members.push({
      key: name,
      name: `${teamName} · ${name}`,
      icon,
      color,
      nicknames: [name],
    });
  }

  return members;
}

function findParentProjectKey({ projects, dirPath, normalizeCwd }) {
  if (!projects || !dirPath) return null;
  const targetDir = normalizeCwd(dirPath);

  for (const [projKey, proj] of Object.entries(projects)) {
    if (normalizeCwd(proj && proj.cwd ? proj.cwd : '') === targetDir) {
      return projKey;
    }
  }

  return null;
}

function ensureTeamMemberWorkspace({ fs, path, execSync, teamDir, teamName, member }) {
  const memberDir = path.join(teamDir, member.key);
  if (!fs.existsSync(memberDir)) fs.mkdirSync(memberDir, { recursive: true });

  const claudeMdPath = path.join(memberDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `# ${member.name}\n\n（团队成员：${teamName}）\n`, 'utf8');
  }

  try {
    if (typeof execSync === 'function') execSync('git init -q', { cwd: memberDir, stdio: 'ignore' });
  } catch {
    // Git init is a best-effort enhancement for checkpoints.
  }

  return {
    ...member,
    cwd: memberDir,
  };
}

function registerTeamMembers({
  cfg,
  parentProjectKey,
  members,
  writeConfigSafe,
  backupConfig,
}) {
  if (!parentProjectKey || !cfg.projects || !cfg.projects[parentProjectKey]) return null;

  const proj = cfg.projects[parentProjectKey];
  if (!Array.isArray(proj.team)) proj.team = [];

  for (const member of members) {
    if (proj.team.some(existing => existing && existing.key === member.key)) continue;
    proj.team.push({
      key: member.key,
      name: member.name,
      icon: member.icon,
      color: member.color,
      cwd: member.cwd,
      nicknames: member.nicknames,
    });
  }

  if (typeof writeConfigSafe === 'function') writeConfigSafe(cfg);
  if (typeof backupConfig === 'function') backupConfig();
  return parentProjectKey;
}

function createTeamWorkspace({
  fs,
  path,
  execSync,
  dirPath,
  teamName,
  members,
  loadConfig,
  normalizeCwd,
  writeConfigSafe,
  backupConfig,
  HOME,
}) {
  const teamDir = path.join(dirPath, 'team');
  if (!fs.existsSync(teamDir)) fs.mkdirSync(teamDir, { recursive: true });

  const createdMembers = members.map((member) => ensureTeamMemberWorkspace({
    fs,
    path,
    execSync,
    teamDir,
    teamName,
    member,
  }));

  const cfg = typeof loadConfig === 'function' ? loadConfig() : { projects: {} };
  const parentProjectKey = findParentProjectKey({
    projects: cfg.projects,
    dirPath,
    normalizeCwd,
  });

  registerTeamMembers({
    cfg,
    parentProjectKey,
    members: createdMembers,
    writeConfigSafe,
    backupConfig,
  });

  return {
    teamDir,
    parentProjectKey,
    memberLines: createdMembers.map((member) => `${member.icon} ${member.key}: ${member.cwd.replace(HOME, '~')}`),
  };
}

module.exports = {
  VALID_TEAM_COLORS,
  parseTeamMembers,
  createTeamWorkspace,
};
