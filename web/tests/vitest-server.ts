/**
 * Global setup of the vitest `e2e` project: one server for the run, its
 * URL handed to the tests through `inject('base')`.
 */
import type { TestProject } from 'vitest/node';
import { startServer } from './server';

declare module 'vitest' {
	export interface ProvidedContext {
		base: string;
	}
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const server = await startServer();
	project.provide('base', server.url);
	return server.stop;
}
