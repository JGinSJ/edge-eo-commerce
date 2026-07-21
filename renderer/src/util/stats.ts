import os from 'node:os';

export const GB = 1024 * 1024 * 1024;

export const systemStats = () => {
	return {
		freeMem: os.freemem() / GB,
	};
};
