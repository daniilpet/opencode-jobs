import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateDirectory = () => process.env.OPENCODE_JOBS_STATE ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode-jobs');
export const anchorDirectory = () => join(stateDirectory(), 'anchor');
