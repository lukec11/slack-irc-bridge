require("dotenv").config();
const { App } = require("@slack/bolt");
const irc = require("irc");
const replaceAsync = require("string-replace-async");

const {
	IRC_USERNAME,
	IRC_PASSWORD,
	IRC_BRIDGE_CHANNEL,
	SLACK_BRIDGE_CHANNEL,
	APP_ID,
	IRC_CHANNEL_PASSWORD,
	IRC_ADDRESS
} = process.env;

//sleep 10 seconds before starting app
(async () => await new Promise(resolve => setTimeout(resolve, 10000)))();

//register irc client
const client = new irc.Client(IRC_ADDRESS, IRC_USERNAME, {
	channels: [IRC_BRIDGE_CHANNEL]
});

const app = new App({
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	token: process.env.SLACK_BOT_TOKEN
});

//utility functions
const getSlackUsername = async uid => {
	const res = await app.client.users.info({
		token: process.env.SLACK_BOT_TOKEN,
		user: uid
	});
	return await res.user.profile.display_name_normalized;
};

const sendToSlackAsUser = async (channel, text, username) => {
	const res = await app.client.chat.postMessage({
		token: process.env.SLACK_BOT_TOKEN,
		channel: channel,
		text: text,
		username: username,
		icon_emoji: ":speech_balloon:"
	});
	return await res;
};

const sendToIrcAsUser = (channel, text, username) => {
	client.say(channel, `<${username}> ${text}`);
};

//listens for messages from irc
client.addListener(
	`message${process.env.IRC_BRIDGE_CHANNEL}`,
	async (from, message) => {
		if (from === IRC_USERNAME) {
			// doesn't send its own messages
			return;
		}
		await sendToSlackAsUser(SLACK_BRIDGE_CHANNEL, message, from);
	}
);

//listens for /me from irc
client.addListener("action", async (from, _, text) => {
	if (from === IRC_USERNAME) {
		//doesn't send own /me (should be impossible, but sure)
		return;
	}
	//equivalent to slack's /me - italicized text
	let responseText = `_${text}_`;

	await sendToSlackAsUser(SLACK_BRIDGE_CHANNEL, responseText, from);
});

client.addListener(`pm`, (from, message) => {
	console.log("recieved a PM!");
	console.log(`${from}: ${message}`);
});

client.addListener("registered", () => {
	client.say("nickserv", `IDENTIFY ${IRC_PASSWORD}`);
	console.log("identified");
	client.send("MODE", IRC_USERNAME, "+B");
	console.log("set +B");
	client.join(`${IRC_BRIDGE_CHANNEL} ${IRC_CHANNEL_PASSWORD}`);
	console.log("joined");
});

//listens for messages from slack
app.message(async ({ event }) => {
	if (event.user === APP_ID) {
		//don't send own messages
		return;
	}

	let sentMessage = event.text;

	//deal with attachments
	if (event.hasOwnProperty("attachments")) {
		let attachments = event.attachments;
		for (attachment of attachments) {
			sentMessage += `${(event.text ? "\n" : "")}${attachment.pretext || ""}\n${
				attachment.text || attachment.fallback || ""
			}\n`;
			if (attachment.hasOwnProperty("title_link")) {
				sentMessage += `${attachment.title_link}\n`;
			}
		}
	}
	//deal with @s in messages
	sentMessage = await replaceAsync(
		sentMessage,
		/<@([A-Z0-9]+?)>/g,
		async (match, p1) => {
			return `@${await getSlackUsername(p1)}`;
		}
	);

	//deal with links in messages
	sentMessage = sentMessage.replace(/<(http[s]?)\:\/\/([^>|]*)[|]?([^>]*)>/gi, (_, p1, p2, p3) => {
		return `${p3} (${p1}://${p2})`;
	});

	//deal with images in messages
	if (event.hasOwnProperty('files')) {
		let files = event.files;
		for (let file of files) {
			sentMessage += `${(event.text || event.attachments ? "\n" : "")}FILE "${file.name || file.title || "" }" (${file.url_private || file.url_private_download || "URL not found!"})`
		}
	}

	sendToIrcAsUser(
		IRC_BRIDGE_CHANNEL,
		sentMessage,
		(await getSlackUsername(event.user)) || event.bot_profile.name
	);
});

client.addListener("error", message => {
	//listens for errors on irc socket
	console.error(message);
});

app.error(error => {
	//listens for errors on slack bolt
	console.error(error);
});


(async () => {
	await app.start(3000);
})();
