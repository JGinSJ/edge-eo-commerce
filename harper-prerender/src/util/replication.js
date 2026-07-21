/**
 * @module replication
 *
 * Provides utility functions for distributing work across nodes
 * in a replicated prerendering cluster.
 *
 * Responsibilities:
 * - Maintain a list of available nodes.
 * - Select random values from arrays.
 * - Assign a random node for page processing.
 */

/**
 * List of available nodes in the cluster.
 * Includes the current server’s hostname and all configured nodes.
 *
 * @type {string[]}
 */
export const nodes = [server.hostname, ...server.nodes.map(({ name }) => name)];

/**
 * Select a random value from a non-empty array.
 *
 * @param {any[]} array - Array of values.
 * @returns {any} A randomly selected element.
 * @throws {Error} If the input is not a non-empty array.
 */
export const getRandomValue = (array) => {
	if (!Array.isArray(array) || array.length === 0) {
		throw new Error('Input must be a non-empty array');
	}
	const randomIndex = Math.floor(Math.random() * array.length);
	return array[randomIndex];
};

/**
 * Get a random node name from the cluster.
 *
 * @returns {string} A randomly selected node name.
 */
export const getPageNode = () => {
	return getRandomValue(nodes);
};
