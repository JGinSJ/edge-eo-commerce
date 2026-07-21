/**
 * @module Mutex
 *
 * Provides a simple inter-thread mutex (mutual exclusion lock) using
 * `SharedArrayBuffer` and `Atomics`. This ensures that only one worker
 * thread at a time can hold the lock, enabling safe coordination when
 * accessing shared resources.
 *
 * The mutex is requested from the main thread via inter-thread messaging.
 * Once initialized, worker threads can acquire and release the lock
 * around critical sections.
 */

import { parentPort, threadId } from 'node:worker_threads';

const UNLOCKED = 0;
const LOCKED = 1;

/**
 * Class representing a mutual exclusion (mutex) lock between worker threads.
 */
export default class Mutex {
	/**
	 * Initialize a `Mutex` instance by requesting a shared buffer from the main thread.
	 *
	 * @returns {Promise<Mutex>} Resolves with a `Mutex` instance once the shared buffer is received.
	 */
	static init() {
		return new Promise((resolve, _reject) => {
			parentPort
				.on('message', (msg) => {
					if (msg?.type === 'render_jobs/worker/mutex-res') {
						resolve(new Mutex(msg.sharedBuffer));
					}
				})
				.unref();

			// Request shared buffer from main thread
			parentPort.postMessage({ type: 'render_jobs/worker/mutex-req' });
		});
	}

	/**
	 * Whether this thread currently holds the lock.
	 * @type {boolean}
	 */
	hasLock = false;

	/**
	 * @param {SharedArrayBuffer} sab - Shared buffer used for atomic operations.
	 */
	constructor(sab) {
		this.i32a = new Int32Array(sab);

		// Ensure the lock is released if the process exits while holding it
		process.once('exit', () => {
			if (this.hasLock) {
				this.unlock();
			}
		});
	}

	/**
	 * Wrap a function so that it always executes under the mutex lock.
	 *
	 * Acquires the lock before running the function, releases it afterwards,
	 * and ensures errors are propagated properly.
	 *
	 * @param {Function} fn - Async function to execute within the lock.
	 * @returns {Function} A wrapped function that enforces locking.
	 */
	withLock(fn) {
		return async (...args) => {
			await this.lock();

			let error;
			let result;

			try {
				result = await fn(...args);
			} catch (e) {
				error = e;
			}

			this.unlock();

			if (error) throw error;

			return result;
		};
	}

	/**
	 * Acquire the lock, blocking until it becomes available.
	 *
	 * If the lock is already taken, the calling thread will wait until another
	 * thread releases it.
	 *
	 * @returns {Promise<void>} Resolves once the lock is acquired.
	 * @throws {Error} Only in rare cases if Atomics operations behave unexpectedly.
	 */
	async lock() {
		logger.info('acquiring lock');
		while (true) {
			// Try to swap UNLOCKED → LOCKED atomically
			if (Atomics.compareExchange(this.i32a, 0, UNLOCKED, LOCKED) === UNLOCKED) {
				this.hasLock = true;
				logger.info('Locked by thread:', threadId);
				return;
			}

			// Wait until the lock becomes available
			const result = Atomics.waitAsync(this.i32a, 0, LOCKED);
			await result.value;
		}
	}

	/**
	 * Release the lock.
	 *
	 * Notifies one waiting thread (if any) that the lock is available.
	 *
	 * @returns {void}
	 * @throws {Error} If the current thread tries to unlock without holding the lock.
	 */
	unlock() {
		const oldValue = Atomics.compareExchange(this.i32a, 0, LOCKED, UNLOCKED);
		if (oldValue !== LOCKED) {
			throw new Error(`Thread tried to unlock while not holding the mutex: ${threadId}`);
		}
		Atomics.notify(this.i32a, 0, 1);
		this.hasLock = false;
		logger.info('Unlocked by thread:', threadId);
	}
}
