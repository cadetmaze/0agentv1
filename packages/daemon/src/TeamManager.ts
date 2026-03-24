import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

export interface TeamMembership {
  team_id: string;
  team_name: string;
  invite_code: string;
  server_url: string;     // e.g., "http://192.168.1.42:4201"
  entity_node_id: string;
  joined_at: number;
  last_synced_at: number;
}

export interface TeamsConfig {
  memberships: TeamMembership[];
}

const TEAMS_PATH = resolve(homedir(), '.0agent', 'teams.yaml');

export class TeamManager {
  private config: TeamsConfig;

  constructor() {
    if (existsSync(TEAMS_PATH)) {
      this.config = YAML.parse(readFileSync(TEAMS_PATH, 'utf8')) as TeamsConfig;
    } else {
      this.config = { memberships: [] };
    }
  }

  getMemberships(): TeamMembership[] {
    return this.config.memberships;
  }

  getMembership(teamId: string): TeamMembership | null {
    return this.config.memberships.find(m => m.team_id === teamId) ?? null;
  }

  /**
   * Join a team by invite code. Calls the sync server.
   */
  async join(inviteCode: string, serverUrl: string, entityNodeId: string, memberName: string, deviceId: string): Promise<TeamMembership> {
    const code = inviteCode.toUpperCase();

    // Look up team by invite code
    const infoRes = await fetch(`${serverUrl}/api/teams/by-code/${code}`);
    if (!infoRes.ok) throw new Error(`Invalid invite code: ${code}`);
    const teamInfo = await infoRes.json() as { id: string; name: string; invite_code: string };

    // Register as member
    const joinRes = await fetch(`${serverUrl}/api/teams/${teamInfo.id}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_node_id: entityNodeId, name: memberName, device_id: deviceId }),
    });
    if (!joinRes.ok) throw new Error('Failed to join team');

    const membership: TeamMembership = {
      team_id: teamInfo.id,
      team_name: teamInfo.name,
      invite_code: teamInfo.invite_code,
      server_url: serverUrl,
      entity_node_id: entityNodeId,
      joined_at: Date.now(),
      last_synced_at: 0,
    };

    // Don't add duplicate
    const existing = this.config.memberships.findIndex(m => m.team_id === membership.team_id);
    if (existing >= 0) {
      this.config.memberships[existing] = membership;
    } else {
      this.config.memberships.push(membership);
    }
    this.save();

    return membership;
  }

  leave(teamId: string): void {
    this.config.memberships = this.config.memberships.filter(m => m.team_id !== teamId);
    this.save();
  }

  updateLastSynced(teamId: string, timestamp: number): void {
    const m = this.config.memberships.find(m => m.team_id === teamId);
    if (m) { m.last_synced_at = timestamp; this.save(); }
  }

  private save(): void {
    mkdirSync(resolve(homedir(), '.0agent'), { recursive: true });
    writeFileSync(TEAMS_PATH, YAML.stringify(this.config), 'utf8');
  }
}
