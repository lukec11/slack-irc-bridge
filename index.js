require("dotenv").config();
const { App } = require("@slack/bolt");
const irc = require("irc");
const replaceAsync = require("string-replace-async");
const fetch = require("node-fetch");

const {
	IRC_USERNAME,
	IRC_PASSWORD,
	IRC_BRIDGE_CHANNEL,
	SLACK_BRIDGE_CHANNEL,
	APP_ID,
	IRC_CHANNEL_PASSWORD,
	IRC_ADDRESS,
	AIRTABLE_BASE_ID,
	AIRTABLE_API_KEY,
	KUTT_API_KEY
} = process.env;

//airtable shenanigans
const base = require("airtable").base(AIRTABLE_BASE_ID);

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

//sends to slack with certain username
const SPEECH_BUBBLE_URL =
	"https://cdn2.iconfinder.com/data/icons/round-speech-bubbles-outline/64/comment-bubble-outline-03-512.png"; //i'm sorry for the hotlink
const sendToSlackAsUser = async (channel, text, username) => {
	const res = await app.client.chat.postMessage({
		token: process.env.SLACK_BOT_TOKEN,
		channel: channel,
		text: text,
		username: username,
		icon_url: (await getPicUrl(username)) || SPEECH_BUBBLE_URL
	});
	return await res;
};

const sendToIrcAsUser = (channel, text, username) => {
	client.say(channel, `<${username}> ${text}`);
};

//uses airtable to get url of profile picture
const getPicUrl = async nick => {
	try {
		const userRecord = await base("ProfilePic")
			.select({ filterByFormula: `Nick = "${nick}"` })
			.all();

		if (userRecord.length > 0) {
			return userRecord[0].fields.PhotoUrl;
		}
		//otherwise return undefined
		return undefined;
	} catch (err) {
		console.error(err);
	}
};

const updateExistingPic = async (recordId, url) => {
	try {
		await base("ProfilePic").update(recordId, {
			PhotoUrl: url
		});
	} catch (err) {
		console.error(err);
	}
};

const createNewPic = async (nick, url) => {
	try {
		await base("ProfilePic").create({
			Nick: nick,
			PhotoUrl: url
		});
	} catch (err) {
		console.error(err);
	}
};

const setPicUrl = async (nick, url) => {
	try {
		//check if record exists already
		const record = await base("ProfilePic")
			.select({ filterByFormula: `Nick = "${nick}"` })
			.all();
		if (record.length > 0) {
			//it exists already so update it
			await updateExistingPic(record[0].id, url);
		} else {
			//this means that it doesn't exist yet
			await createNewPic(nick, url);
		}
		//return true if it succeeded
		return true;
	} catch (err) {
		console.error(err);
		return false;
	}
};

const shortenUrl = async url => {
	try {
		if (url.length < 32) {
			return url;
		} //returns regular url unless it's long

		let res = await fetch("https://kutt.it/api/v2/links", {
			method: "POST",
			body: JSON.stringify({
				target: url,
				reuse: true
			}),
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": KUTT_API_KEY
			}
		});
		return (await res.json()).link;
	} catch (err) {
		console.error(err);
	}
};

const getChannelName = async channelId => {
	const res = await app.client.conversations.info({
		token: process.env.SLACK_BOT_TOKEN,
		channel: channelId
	});

	return res.channel.name;
};
// listeners

//listens for messages from irc
client.addListener(
	`message${process.env.IRC_BRIDGE_CHANNEL}`,
	async (from, message) => {
		if (from === IRC_USERNAME) {
			// doesn't send its own messages
			return;
		}

		//check if message is a command
		if (message.startsWith("!")) {
			if (message.startsWith("!picture")) {
				try {
					const photoUrl = message.match(
						/!picture (http[s]?\:\/\/.+)/i
					);
					const isPictureSet = await setPicUrl(from, photoUrl[1]);
					if (isPictureSet) {
						client.say(
							IRC_BRIDGE_CHANNEL,
							`${from}: Photo registered!`
						);
					} else {
						client.say(
							IRC_BRIDGE_CHANNEL,
							`${from}: Sorry, that didn't work. Try again?`
						);
					}
				} catch (err) {
					console.error(err);
					client.say(
						IRC_BRIDGE_CHANNEL,
						`${from}: That didn't work. Try again?`
					);
				}
			}
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
			sentMessage += attachment.author_name
				? ` ${attachment.author_name}`
				: ""; //attach author name if available
			sentMessage += `${event.text ? "\n" : ""}${
				attachment.pretext || ""
			} ${attachment.text || attachment.fallback || ""} `;
			if (attachment.hasOwnProperty("title_link")) {
				sentMessage += `${await shortenUrl(attachment.title_link)}\n`;
			}
		}
	}

	//deal with channel names in messages
	sentMessage = await replaceAsync(
		sentMessage,
		/\<\#([CG][A-Z0-9]+)(?:\|[A-z0-9]+)?>/i,
		async (match, p1) => {
			return `#${(await getChannelName(p1)) || "UnknownChannel"}`;
		}
	);

	//deal with @s in messages
	sentMessage = await replaceAsync(
		sentMessage,
		/<@([A-Z0-9]+?)>/g,
		async (match, p1) => {
			return `@${(await getSlackUsername(p1)) || "UnknownUser"}`;
		}
	);

	//deal with normal links in messages
	sentMessage = await replaceAsync(
		sentMessage,
		/<(http[s]?\:\/\/[^>|]*)>/gi,
		async (_, p1) => {
			return await shortenUrl(p1);
		}
	);

	//deal with hyperlinked words in messages
	sentMessage = await replaceAsync(
		sentMessage,
		/<(http[s]?)\:\/\/([^>|]*)[|]([^>]*)>/gi,
		async (_, p1, p2, p3) => {
			return `${p3} (${p1}://${await shortenUrl(p2)})`;
		}
	);

	//deal with images in messages
	if (event.hasOwnProperty("files")) {
		let files = event.files;
		for (let file of files) {
			sentMessage += `${
				event.text || event.attachments ? "\n" : ""
			}FILE "${file.name || file.title || ""}" (${
				file.url_private ||
				file.url_private_download ||
				"URL not found!"
			})`;
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
