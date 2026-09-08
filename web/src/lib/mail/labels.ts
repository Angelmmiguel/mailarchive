/**
 * Labels, since an .eml dump carries no folders: `sent` when the sender is
 * one of the user's own addresses, `attachments` when a part is offered as
 * a file rather than embedded in the HTML. They are worked out from the
 * record whenever they are shown or searched, never stored: the own
 * addresses are a setting, and a label in the immutable index would keep
 * answering for the setting as it was when the message was imported.
 */
import type { ParsedMessage } from './message';

export const SENT = 'sent';
export const ATTACHMENTS = 'attachments';

export function labelsFor(
	message: Pick<ParsedMessage, 'from' | 'attachments'>,
	ownAddresses: string[]
): string[] {
	const labels: string[] = [];
	if (message.from !== null && isOwn(message.from.address, ownAddresses)) labels.push(SENT);
	if (message.attachments.some((a) => !a.inline)) labels.push(ATTACHMENTS);
	return labels;
}

export function isOwn(address: string, ownAddresses: string[]): boolean {
	const wanted = address.toLowerCase();
	return ownAddresses.some((own) => own.toLowerCase() === wanted);
}
