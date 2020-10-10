"use strict";

const { get } = require('lodash');
const Log = require('./log');

const ERROR_NOT_IN_CHANNEL = 'channel_not_found';
const ERROR_MESSAGE_NOT_FOUND = 'message_not_found';

/**
 * Listens to events from Slashbot off the queue and sends them off to Slack.
 */
class SlashListener {
	/**
	 * Initialize listener.
	 *
	 * @param {Chatterbox} chatterbox - The chatterbox that started this listener.
	 * @param {string} queueSuffix - The suffix to add to all queues.
	 */
	constructor(chatterbox, queueSuffix)
	{
		this.chatterbox = chatterbox;
		this.queueSuffix = queueSuffix;
		this.ackDelay = 0;
	}

	/**
	 * Connect to Slack and get things started.
	 */
	async connect()
	{
		const queueName = `out_queue-${this.queueSuffix}`;

		this.ch = await this.chatterbox.mqConnection.createChannel();
		this.ch.prefetch(1);
		this.ch.assertQueue(queueName);
		this.ch.consume(queueName, this.onConsume.bind(this), { noAck: false });

		Log.info(`Connected to queue: '${queueName}'.`);
	}

	/**
	 * Consume a queue message.
	 *
	 * @param {object} message - The message to consume.
	 */
	async onConsume(message)
	{
		let decoded;

		try {
			decoded = JSON.parse(message.content.toString());
			Log.info(`Sending message of type '${decoded.type}' to channel '${decoded.channel}' on team '${decoded.team}'.`);
			Log.debug(decoded, "Message");
			await this.processQueueMessage(decoded);
		} catch (error) {
			if (ERROR_NOT_IN_CHANNEL === error.message) {
				const slack = await this.chatterbox.getSlack(decoded.team);
				await slack.dm(decoded.uid, "The Chat & Slash bot needs to be invited to your channel before you can play.  Type `/invite @chatandslash` before attempting any in-game actions.");
			} else {
				Log.error(error);
				this.chatterbox.reportError(error, decoded);
			}
		} finally {
			setTimeout(() => { this.ackMessage(message); }, this.ackDelay);
		}
	}

	/**
	 * Acknowledge a message from the queue.
	 *
	 * @param {object} message - The message to acknowledge.
	 */
	ackMessage(message)
	{
		this.ch.ack(message);
		this.ackDelay = Math.max(0, this.ackDelay - 10);
	}

	/**
	 * Process a message from the queue, sending it to the right function.
	 *
	 * @param {object} message - The message from the queue.
	 */
	async processQueueMessage(message)
	{
		if (_.isUndefined(message.team)) {
			Log.error(message, "No team id defined.");
			throw new Error("No team id defined.");
		}

		try {
			if ('say' === message.type) {
				const response = await this.say(
					message.channel,
					message.team,
					message.text,
					message.opts,
					message.messageDelay
				);

				this.slackListener.enqueue({
					type: 'add_timestamp',
					payload: {
						ts: response.ts,
						channel: message.channel,
						teamid: message.team,
					},
				});
			}
			else if ('update' === message.type) {
				await this.update(
					message.ts,
					message.channel,
					message.team,
					message.text,
					message.opts
				);
			}
			else if ('delete' === message.type) {
				await this.delete(
					message.ts,
					message.channel,
					message.team
				);
			}
			else if ('dm' === message.type) {
				await this.dm(
					message.uid,
					message.team,
					message.text,
					message.opts,
					message.messageDelay
				);
			}
			else if ('dialog' === message.type) {
				await this.dialog(
					message.team,
					message.triggerId,
					message.dialog,
				);
			}
			else {
				Log.error(message, "Could not identify message type.");
				throw new TypeError(`Invalid message type: '${message.type}'.`);
			}
		}
		catch (error) {
			const data = get(error, 'data', {});
			const type = get(data, 'error', 'unknown');

			if (ERROR_MESSAGE_NOT_FOUND === type) {
				Log.warn('Attempting to delete invalid timestamp.', message);
			}
			else {
				throw error;
			}
		}
	}

	/**
	 * Send a message to a character IMMEDIATELY, should be called when won't trigger rate limiting.
	 *
	 * @param {string} channel - The channel to write to.
	 * @param {string} text - The message to write.
	 * @param {object} options - The message options
	 *
	 * @return void
	 */
	async say(channel, team, text, options, messageDelay = 0)
	{
		const slack = await this.chatterbox.getSlack(team);

		return slack.postMessage(channel, text, options);
	}

	/**
	 * Send a message to a character IMMEDIATELY, should be called when won't trigger rate limiting.
	 *
	 * @param {string} trigger_id - The ID of the message that triggered the dialog.
	 * @param {object} dialog - The dialog to send.
	 *
	 * @return void
	 */
	async dialog(team, trigger_id, dialog)
	{
		const slack = await this.chatterbox.getSlack(team);

		return slack.dialog(trigger_id, dialog);
	}

	/**
	 * Update a message previously sent to a player, without waiting in the queue.
	 *
	 * @param {string} ts - The timestamp of the message to update.
	 * @param {string} channel The channel to update.
	 * @param {string} team - The team to update.
	 * @param {string} text - The message to write.
	 * @param {object} options - The message options.
	 *
	 * @return void
	 */
	async update(ts, channel, team, text, options)
	{
		const slack = await this.chatterbox.getSlack(team);

		return slack.updateMessage(ts, channel, text, options);
	}

	/**
	 * Delete a message previously sent to a player, without waiting in the queue.
	 *
	 * @param {string} ts - The timestamp of the message to delete.
	 * @param {string} channel The channel to delete.
	 * @param {string} team - The team to delete.
	 *
	 * @return void
	 */
	async delete(ts, channel, team)
	{
		const slack = await this.chatterbox.getSlack(team);

		return slack.deleteMessage(ts, channel);
	}

	/**
	 * Direct message to a player, without waiting in the queue.
	 *
	 * @param {string} uid - The UID of the character to DM.
	 * @param {string} team - The team to DM.
	 * @param {string} text - The message to write.
	 * @param {object} options - The message options.
	 *
	 * @return void
	 */
	async dm(uid, team, text, options)
	{
		const slack = await this.chatterbox.getSlack(team);

		return slack.dm(uid, text, options);
	}
}

module.exports = SlashListener;