import ScriptHaul from '../src/index.js';

const client = new ScriptHaul();
const query = process.env.SCRIPTHAUL_QUERY || 'public domain';
const channelInput = process.env.SCRIPTHAUL_CHANNEL || '@YouTube';
const channel = await client.channels.resolve(channelInput);
const page = await client.search(query);
const channelPage = await client.search(query, { channel: channelInput });
const latest = await client.channels.latest({ channel: channel.channel_id });
const playlistLatest = await client.channels.latest({ playlist: channel.uploads_playlist_id });

console.log(JSON.stringify({
  channel_id: channel.channel_id, results: page.results.length,
  channel_results: channelPage.results.length, continuation: page.continuation,
  latest: latest.videos.map((video) => video.video_id),
  playlist_latest: playlistLatest.videos.map((video) => video.video_id),
  credits_charged: page.meta.creditsCharged + channelPage.meta.creditsCharged,
  latest_credits_charged: latest.meta.creditsCharged + playlistLatest.meta.creditsCharged,
}));
