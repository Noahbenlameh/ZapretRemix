'use strict';

// Shared constants/helpers for the Закреплённые / Стратегии / Рекомендации
// tabs — kept in one place so a preset template or domain-family set only
// needs updating once instead of drifting across three duplicated copies.
// 'require view.zapretremix.shared as shared' to use.

// Full per-preset templates (all 3 blocks: HTTP/TLS/QUIC), copied verbatim
// from the actual /opt/zapret2/def-cfg.sh installed this session (NOT
// re-fetched from GitHub — that repo has since moved on to different
// contributor presets entirely; the router's installed copy is the only
// authoritative source). <HOSTLIST>/<HOSTLIST_NOAUTO> get replaced with a
// literal --hostlist=<per-pin file> for just this one block, independent
// of whatever the global hostlist/autohostlist is doing elsewhere.
// v1_by_Routerich deliberately excluded — too large/complex (14 numbered
// sub-strategies with hardcoded google.com-specific hostlist references)
// to safely templatize by hand.
var PIN_TEMPLATES = {
	default:
		'--filter-tcp=80\n--filter-l7=http <HOSTLIST>\n--payload=http_req\n--lua-desync=fake:blob=fake_default_http:tcp_md5\n--lua-desync=multisplit:pos=method+2\n\n' +
		'--new\n--filter-tcp=443\n--filter-l7=tls <HOSTLIST>\n--payload=tls_client_hello\n--lua-desync=fake:blob=fake_default_tls:tcp_md5:tcp_seq=-10000\n--lua-desync=multidisorder:pos=1,midsld\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--payload=quic_initial\n--lua-desync=fake:blob=fake_default_quic:repeats=6',

	v1_by_Schiz23:
		'--filter-tcp=80\n--filter-l7=http <HOSTLIST>\n--payload=http_req\n--lua-desync=fake:blob=fake_default_http:tcp_md5\n--lua-desync=multisplit:pos=method+2\n\n' +
		'--new\n--filter-tcp=443\n--filter-l7=tls <HOSTLIST>\n--lua-desync=fake:blob=fake_default_tls:ip_ttl=1:ip6_ttl=1:tls_mod=rnd,rndsni,padencap\n--lua-desync=multidisorder:payload=tls_client_hello:pos=3\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--lua-desync=fake:blob=fake_default_quic:repeats=11:payload=all:out_range=-d10',

	v2_by_Schiz23:
		'--filter-tcp=80\n--filter-l7=http <HOSTLIST>\n--payload=http_req\n--lua-desync=fake:blob=fake_default_http:tcp_md5\n--lua-desync=multisplit:pos=method+2\n\n' +
		'--new\n--filter-tcp=443\n--filter-l7=tls <HOSTLIST>\n--payload=tls_client_hello\n--lua-desync=multidisorder:payload=tls_client_hello:pos=100,midsld,sniext+1,endhost-2,-10\n--lua-desync=send:sni=.microsoft\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--payload=quic_initial\n--lua-desync=fake:blob=fake_default_quic:repeats=11',

	v1_by_AnonymTsk:
		'--blob=blob_tls_clienthello_www_google_com:@/opt/zapret2/files/fake/tls_clienthello_www_google_com.bin\n--blob=blob_quic_initial_www_google_com:@/opt/zapret2/files/fake/quic_initial_www_google_com.bin\n\n' +
		'--filter-tcp=443,80\n--filter-l7=http,tls <HOSTLIST>\n--payload=tls_client_hello\n--lua-desync=fake:blob=fake_default_tls:tls_mod=rnd,dupsid,sni=www.google.com:tcp_ts=-1000\n--lua-desync=multidisorder:pos=1,midsld,sniext+1,endhost-2,-10:seqovl=1:seqovl_pattern=blob_tls_clienthello_www_google_com:tcp_ts_up\n--payload=http_req\n--lua-desync=http_methodeol:badsum\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--payload=quic_initial\n--lua-desync=fake:blob=blob_quic_initial_www_google_com:repeats=11'
};

var PRESET_CHOICES = [
	{ key: 'default', title: 'По умолчанию' },
	{ key: 'v1_by_Schiz23', title: 'Schiz23 v1' },
	{ key: 'v2_by_Schiz23', title: 'Schiz23 v2' },
	{ key: 'v1_by_AnonymTsk', title: 'AnonymTsk v1 (Discord/Telegram/UDP)' }
];

var STRATEGY_TITLES = {};
PRESET_CHOICES.forEach(function (p) { STRATEGY_TITLES[p.key] = p.title; });

// A service is rarely just one domain — video/CDN/API traffic for it usually
// lives on completely separate domains with their own DNS resolution (e.g.
// YouTube's player pulls video from googlevideo.com, not youtube.com). A pin
// or a strategy test that only covers the "main" domain leaves those
// uncovered — site loads, content doesn't. These are convenience starting
// points, not guaranteed exhaustive — add more domains by hand if something's
// still broken.
var FAMILY_PRESETS = {
	youtube: {
		title: 'YouTube',
		domains: [ 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
			'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtubei.googleapis.com' ]
	},
	discord: {
		title: 'Discord',
		domains: [ 'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net',
			'media.discordapp.net', 'cdn.discordapp.com', 'gateway.discord.gg' ]
	},
	instagram: {
		title: 'Instagram',
		domains: [ 'instagram.com', 'www.instagram.com', 'cdninstagram.com', 'fbcdn.net' ]
	},
	twitter: {
		title: 'Twitter / X',
		domains: [ 'twitter.com', 'x.com', 'twimg.com', 't.co' ]
	}
};

function safeName(domain) {
	return domain.replace(/[^a-zA-Z0-9.\-]/g, '_');
}

function fillHostlist(template, pinFile) {
	return template
		.replace(/<HOSTLIST_NOAUTO>/g, '--hostlist=' + pinFile)
		.replace(/<HOSTLIST>/g, '--hostlist=' + pinFile);
}

// Splits on whitespace/commas, drops empties/dupes, strips anything not
// domain-safe. Used anywhere a user pastes a list of domains into one box.
function parseDomains(raw) {
	var seen = {};
	var out = [];
	(raw || '').split(/[\s,]+/).forEach(function (d) {
		d = d.trim().replace(/[^a-zA-Z0-9.\-]/g, '');
		if (d && !seen[d]) { seen[d] = true; out.push(d); }
	});
	return out;
}

// pins.json historically stored one domain per pin as a plain `domain`
// string. Normalize old entries to the current `{ id, domains: [...] }`
// shape so every reader stays compatible with entries created before the
// multi-domain change without a migration step.
function normalizePin(pin) {
	if (Array.isArray(pin.domains) && pin.domains.length) {
		return { id: pin.id || safeName(pin.domains[0]), domains: pin.domains, preset: pin.preset, dns: pin.dns || '' };
	}
	return { id: safeName(pin.domain), domains: [ pin.domain ], preset: pin.preset, dns: pin.dns || '' };
}

return {
	PIN_TEMPLATES: PIN_TEMPLATES,
	PRESET_CHOICES: PRESET_CHOICES,
	STRATEGY_TITLES: STRATEGY_TITLES,
	FAMILY_PRESETS: FAMILY_PRESETS,
	safeName: safeName,
	fillHostlist: fillHostlist,
	parseDomains: parseDomains,
	normalizePin: normalizePin
};
