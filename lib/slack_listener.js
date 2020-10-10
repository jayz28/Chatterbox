"use strict";

const express    = require('express');
const https      = require('https');
const bodyParser = require('body-parser');
const crypto     = require('crypto');
const request    = require('request-promise-native');
const fs         = require('fs');
const { get }    = require('lodash');
const Log        = require('./log');

const COMMAND_CHATANDSLASH = '/chatandslash';
const CHANNEL_PRIVATEGROUP = 'privategroup';
const ERROR_NOT_IN_CHANNEL = 'channel_not_found';
const ERROR_CHANNEL_EXISTS = 'name_taken';
const ERROR_USER_CANCEL = 'access_denied';
const ERROR_CODE_ALREADY_USED = 'code_already_used';

const EVENT_QUEUE  = 'event_queue';

const EVENT_URL_VERIFICATION = 'url_verification';
const EVENT_CALLBACK = 'event_callback';
const EVENT_TEAM_JOIN = 'team_join';

const URL_SUFFIX = process.env.MODE === 'dev' ? 'local' : 'com';
const URL_OAUTH_SUCCESS = `https://www.chatandslash.${URL_SUFFIX}/installed/`;
const URL_OAUTH_ERROR = `https://www.chatandslash.${URL_SUFFIX}/install_problem/?id=`;
const URL_OAUTH_CANCEL = `https://www.chatandslash.${URL_SUFFIX}/install_cancel/?id=`;

// Modify express so we can use async controllers without worrying about promises falling through.
require('node-express-async');

/**
 * Listens to events from Slack and fires 'em onto the in_queue.
 */
class SlackListener {
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
		this.inQueueName = `in_queue-${this.queueSuffix}`;
	}

	/**
	 * Connect to queue and prepare to accept connections.
	 */
	async connect()
	{
		const app = express();
		app.use(bodyParser.urlencoded({ extended: true }));
		app.use(bodyParser.json());

		app.get('/ping', this.onPing.bind(this));
		app.get('/slack/oauth', this.onOAuth.bind(this));
		app.post('/slack/button', this.onButton.bind(this));
		app.post('/slack/slash', this.onSlash.bind(this));
		app.post('/slack/event', this.onEvent.bind(this));
		app.post('/payment', this.onPayment.bind(this));

		const options = {
			key:  fs.readFileSync(`./certs/${process.env.CERT_KEY}`),
			cert: fs.readFileSync(`./certs/${process.env.CERT_CRT}`),
			ca:   fs.readFileSync(`./certs/${process.env.CERT_CA}`)
		};

		if (process.env.MODE === 'dev') {
			app.listen(process.env.PORT, function() {
				Log.info(`Server listening on: http://${process.env.URL}:${process.env.PORT}`);
			});
		}
		else {
			const server = https.createServer(options, app);
			server.listen(process.env.PORT, function() {
				Log.info(`Server listening on: https://${process.env.URL}:${process.env.PORT}`);
			});
		}

		this.ch = await this.chatterbox.mqConnection.createChannel();
	}

	/**
	 * Attempt to get the channel for a character.
	 *
	 * @param {string} uid - The ID of the character to check.
	 * @param {string} teamid - The ID of the team to check.
	 *
	 * @return {string}
	 */
	async getCharacterChannel(uid, teamid)
	{
		const query = 'SELECT * FROM characters WHERE uid = ? AND teamid = ?';
		const params = [uid, teamid];

		const connection = await DB_POOL.getConnection();
		const [rows, ] = await connection.query(query, params);
		connection.release();

		return rows.length > 0 ? rows[0].channel : '';
	}

	/**
	 * Enqueue a message in the in queue.
	 *
	 * @param {object} msg - The message to enqueue.
	 */
	async enqueue(msg)
	{
		this.ch.assertQueue(this.inQueueName);
		this.ch.sendToQueue(this.inQueueName, Buffer.from(JSON.stringify(msg)));
	}

	/**
	 * Add an event to the event queue.
	 *
	 * @param {string} event - The type of event to enqueue.
	 * @param {integer} characterId - The ID of the character triggering this event.
	 * @param {object} fields - The fields of the event.
	 */
	enqueueEvent(event, characterId, fields)
	{
		this.ch.assertQueue(EVENT_QUEUE);
		this.ch.sendToQueue(EVENT_QUEUE, Buffer.from(JSON.stringify({
			event,
			character_id: characterId,
			fields
		})));
	}

	/**
	 * A ping request has been submitted.
	 *
	 * @param {Request} req - The request that came in.
	 * @param {Response} res - The response to send back.
	 */
	async onPing(req, res)
	{
		Log.info('Pong!');
		res.send('Chat & Slash is up & running!');
	}

	/**
	 * Authorizing this app with a new team.
	 *
	 * @param {Request} req - The request that came in.
	 * @param {Response} res - The response to send back.
	 */
	async onOAuth(req, res)
	{
		let body;

		// User cancelled the OAuth request?
		if (ERROR_USER_CANCEL === get(req.query, 'error')) {
			return res.redirect(URL_OAUTH_CANCEL + process.env.CLIENT_ID);
		}

		try {
			Log.info('Incoming oAuth request:', req.query.code);

			const options = {
				method: 'POST',
				uri: 'https://slack.com/api/oauth.access',
				formData: {
					client_id: process.env.CLIENT_ID,
					client_secret: process.env.CLIENT_SECRET,
					code: req.query.code,
				}
			};

			body = JSON.parse(await request(options));

			if ( ! body.ok) {
				const reason = _.get(body, 'error', 'Unknown error');

				if (ERROR_CODE_ALREADY_USED === reason) {
					return res.redirect(URL_OAUTH_ERROR + process.env.CLIENT_ID);
				}

				throw new Error(`Could not validate OAuth request: '${reason}'.`);
			}

			const fields = {
				teamid: body.team_id,
				team_name: body.team_name,
				app_token: body.access_token,
				bot_token: body.bot.bot_access_token,
				bot_id: body.bot.bot_user_id,
			};

			const connection = await DB_POOL.getConnection();
			await connection.query('REPLACE INTO teams SET ?', fields, fields);
			connection.release();

			this.enqueueEvent("Workspace Install", 0, { name: body.team_name });
			Log.info(`Installed Chat & Slash on ${body.team_name} (${body.team_id}).`);

			res.redirect(URL_OAUTH_SUCCESS);
		}
		catch (error) {
			this.chatterbox.reportError(error, {
				body,
				query: req.query,
			});
			Log.error(error);
			Log.error("Query:", req.query);
			Log.error("Body:", body);
			res.redirect(URL_OAUTH_ERROR + process.env.CLIENT_ID);
		}
	}

	/**
	 * A button has been pressed.
	 *
	 * @param {Request} req - The request that came in.
	 * @param {Response} res - The response to send back.
	 */
	async onButton(req, res)
	{
		res.send('');
		await this.processPayload('button', JSON.parse(req.body.payload));
	}

	/**
	 * A slash command has been received.
	 *
	 * @param {Request} req - The request that came in.
	 * @param {Response} res - The response to send back.
	 */
	async onSlash(req, res)
	{
		res.send('');

		// Can only reply to slash messages from private channels
		if ('G' !== req.body.channel_id.substr(0, 1)) {
			return;
		}

		if (req.body.command === COMMAND_CHATANDSLASH) {
			await this.onChatAndSlash(req.body);
		}
		else {
			await this.processPayload('slash', req.body);
		}
	}

	/**
	 * An event has happened on the workspace that we care about.
	 *
	 * @param {Request} req - The request that came in.
	 * @param {Response} res - The response to send back.
	 */
	async onEvent(req, res)
	{
		let response = '';

		if (process.env.VERIFICATION_TOKEN === req.body.token) {
			if (EVENT_URL_VERIFICATION === req.body.type) {
				response = req.body.challenge;
			}
			else if (EVENT_CALLBACK === req.body.type) {
				await this.processEvent(req.body.event);
			}
		}

		res.send(response);
	}

	/**
	 * Oh hey, we got paid!
	 *
	 * @param {Request} req - The request that came in.
	 * @param {Response} res - The response to send back.
	 */
	async onPayment(req, res)
	{
		res.send('');
		await this.processPayload('payment', req.body);
	}

	/**
	 * Verify and enqueue a payload.
	 *
	 * @param {string} type - The type identifier of the payload.
	 * @parma {object} payload - The payload to process.
	 */
	async processPayload(type, payload)
	{
		if (this.isValidToken(type, payload.token)) {
			Log.debug(payload, _.capitalize(type));
			await this.enqueue({ type, payload });
		}
		else {
			Log.warn(`Payload token '${payload.token}' is not valid.`);
		}
	}

	/**
	 * If the token in the payload is valid for Slack or the CNS API.
	 *
	 * @param {string} requestType - The type of the request being enqueued.
	 * @param {string} token - The token to compare.
	 *
	 * @return {boolean}
	 */
	isValidToken(requestType, token)
	{
		if ('payment' === requestType && process.env.CNS_API_TOKEN === token) {
			return true;
		}
		else if (process.env.VERIFICATION_TOKEN === token) {
			return true;
		}

		return false;
	}

	/**
	 * Handle the /chatandslash command.  Either begin a new game, or provide info.
	 *
	 * @param {object} payload - The payload to process.
	 */
	async onChatAndSlash(payload)
	{
		const slack = await this.chatterbox.getSlack(payload.team_id);

		// Ensure we're in a private channel - no games in publich channels!
		if (payload.channel_name !== CHANNEL_PRIVATEGROUP) {
			Log.warn(`Attempt to start game in public channel on team ${payload.team_id}, channel ${payload.channel_id}, by user ${payload.user_id}.`);
			return await slack.dm(payload.user_id, "You can't play Chat & Slash in public channels.  Create a new private channel, then `/invite @chatandslash` before typing `/chatandslash`.");
		}

		try {
			await slack.getConversationMembers(payload.channel_id);
		}
		catch (err) {
			if (ERROR_NOT_IN_CHANNEL === err.message) {
				Log.warn(`Attempt to start game without bot in channel on team ${payload.team_id}, channel ${payload.channel_id}, by user ${payload.user_id}.`);
				return await slack.dm(payload.user_id, "The Chat & Slash bot needs to be invited to your channel before you can play.  Type `/invite @chatandslash` before typing `/chatandslash`.");
			}

			throw err;
		}

		// If a character already exists, point them to that channel.
		const existingChannel = await this.getCharacterChannel(payload.user_id, payload.team_id);

		// If issued in player's channel, pass along to Slashbot for info
		if (existingChannel === payload.channel_id) {
			return await this.processPayload('slash', payload);
		}
		else if ('' !== existingChannel) {
			Log.warn(`Attempt to start game in second channel on team ${payload.team_id}, channel ${payload.channel_id}, by user ${payload.user_id}.`);
			const channelInfo = await slack.getConversationInfo(existingChannel);
			return await slack.dm(payload.user_id, `You already have a game of Chat & Slash on this team, in the channel: \`${channelInfo.name}\`.`);
		}

		const info = await slack.userInfo(payload.user_id);

		this.finalizeNewGame(
			payload.user_id,
			payload.team_id,
			payload.channel_id,
			info.user.real_name,
			info.user.profile.email
		);
	}

	/**
	 * Enqueue and log new game.
	 *
	 * @param {string} uid - The ID of the user.
	 * @param {string} teamid - The ID of the user's team.
	 * @param {string} channel - The channel the user is in.
	 * @param {string} name - The user's name.
	 * @param {email} email - The user's email.
	 */
	finalizeNewGame(uid, teamid, channel, name, email)
	{
		this.enqueue({
			type: 'new-game',
			payload: { uid, teamid, channel, name, email }
		});

		Log.info({ uid, charName: name, email, channel }, 'Starting new game.');
	}

	/**
	 * Process an event sent to us from Slack.
	 *
	 * @param {object} event - The event to process.
	 */
	async processEvent(event)
	{
		if (EVENT_TEAM_JOIN === event.type) {
			const slack = await this.chatterbox.getSlack(event.user.team_id);
			if (slack.autoStart) {
				const info = await slack.userInfo(event.user.id);
				const channel = await this.joinUserToNewChannel(
					event.user.id,
					info.user.real_name,
					info.user.profile.email,
					this.createChannelName(),
					slack
				);

				this.finalizeNewGame(
					event.user.id,
					event.user.team_id,
					channel,
					info.user.real_name,
					info.user.profile.email
				);
			}
		}
		else {
			Log.warn(`Unexpected event type: '${event.type}'.`);
		}
	}

	/**
	 * Create a new channel and join the user to it.
	 *
	 * @param {string} uid - The UID of the character.
	 * @param {string} name - The character's name.
	 * @param {string} email - The character's email.
	 * @param {string} channel - The private channel the game will be played in.
	 * @param {Slacksimple} slack - Interface with slack.
	 *
	 * @return {string} The ID of the channel the user was joined to.
	 */
	async joinUserToNewChannel(uid, name, email, channel, slack)
	{
		const createResponse = await slack.createPrivateChannel(channel);
		if ( ! createResponse.ok) {

			// Whoops, despite our best efforts, that channel name exists.  Try again!
			if (ERROR_CHANNEL_EXISTS === _.get(createResponse, 'error', '')) {
				Log.warn('Tried to create channel that already exists: ', channel);
				return this.joinUserToNewChannel(uid, name, email, this.createChannelName(), slack);
			}

			Log.error(createResponse, "Could not create private channel.");
			throw new Error("Could not create private channel.");
		}

		// Invite the user to the channel
		const inviteResponse = await slack.invitePrivateChannel(createResponse.group.id, uid);
		if ( ! inviteResponse.ok) {
			if (process.env.MODE === 'dev' && inviteResponse.error === 'cant_invite_self') {
				Log.info('Skipping cannot invite self in dev mode error.');
			}
			else {
				Log.error(inviteResponse, "Could not invite user to channel.");
				throw new Error("Could not invite user to channel.");
			}
		}

		// Invite bot to the channel
		const botInviteResponse = await slack.invitePrivateChannel(createResponse.group.id, slack.botId);
		if ( ! botInviteResponse.ok) {
			Log.error(botInviteResponse, "Could not invite bot to channel.");
			throw new Error("Could not invite bot to channel.");
		}

		return createResponse.group.id;
	}

	/**
	 * Create a random channel name to invite players to.
	 *
	 * @return string
	 */
	createChannelName()
	{
		return 'game-' + crypto.randomBytes(3).toString('hex');
	}

}

module.exports = SlackListener;