require('dotenv').config();
const { App } = require('@slack/bolt');
const irc = require('irc');

const {
	IRC_USERNAME,
	IRC_PASSWORD,
	IRC_BRIDGE_CHANNEL,
	SLACK_BRIDGE_CHANNEL,
	APP_ID,
	IRC_CHANNEL_PASSWORD,
	IRC_ADDRESS
} = process.env;

//sleep 5 seconds before starting app
;(async () => await new Promise(resolve => setTimeout(resolve, 5000)))();

//register irc client
const client = new irc.Client(IRC_ADDRESS, IRC_USERNAME, {
	channels: [IRC_BRIDGE_CHANNEL],
});

const app = new App({
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	token: process.env.SLACK_BOT_TOKEN
});

//utility functions
const getSlackUsername = async (uid) => {
	const res = await app.client.users.info({
		token: process.env.SLACK_BOT_TOKEN,
		user: uid
	});
	return await res.user.profile.display_name_normalized;
}

const sendToSlackAsUser = async (channel, text, username) => {
	const res = await app.client.chat.postMessage({
		token: process.env.SLACK_BOT_TOKEN,
		channel: channel,
		text: text,
		username: username,
		icon_emoji: ':speech_balloon:'
	});
	return await res;
}

const sendToIrcAsUser = (channel, text, username) => {
	client.say(channel, `<${username}> ${text}`);
}


//listens for messages from irc
client.addListener(`message${process.env.IRC_BRIDGE_CHANNEL}`, async (from, message) => {
	if (from === IRC_USERNAME) {
		// doesn't send its own messages
		return;
	}
	await sendToSlackAsUser(SLACK_BRIDGE_CHANNEL, message, from);
});

client.addListener(`pm`, (from, message) => {
	console.log('recieved a PM!');
	console.log(`${from}: ${message}`);
});

client.addListener('registered', () => {
	client.say('nickserv', `IDENTIFY ${IRC_PASSWORD}`)
	console.log('identified');
	client.send('MODE', IRC_USERNAME, '+B')
	console.log('set +B');
	client.join(`${IRC_BRIDGE_CHANNEL} ${IRC_CHANNEL_PASSWORD}`);
	console.log('joined');

})

//listens for messages from slack
app.message(async ({ event }) => {
	if (event.user === APP_ID) {
		//don't send own messages
		return;
	}

	let sentMessage = event.text;

	if (event.hasOwnProperty('attachments')) {
		sentMessage = `${event.text}\n${event.attachments.pretext}\n${event.attachments.fallback}`	
	}

	sendToIrcAsUser(IRC_BRIDGE_CHANNEL, sentMessage, await getSlackUsername(event.user));
})


client.addListener('error', (message) => { //listens for errors on irc socket
	console.error(message);
});

app.error((error) => { //listens for errors on slack bolt
	console.error(error);
});


(async () => {
	await app.start(3000);
})();
