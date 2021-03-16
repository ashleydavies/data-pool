import ObjectEvent from "@rbxts/object-event";
import { HttpService } from "@rbxts/services";

const messagingService = game.GetService("MessagingService");

type HashKey = string;

export type Hasher<T> = (a: T) => HashKey;
export type Serializer<T> = (a: T) => HashKey;
export type Deserializer<T> = (a: string) => T;

type GeneralMessage = {
	type: string;
	seid: string;
};

type SetMessage = {
	type: "set";
	data: string;
} & GeneralMessage;

type RemoveMessage = {
	type: "remove";
	key: HashKey;
} & GeneralMessage;

type ClearMessage = {
	type: "clear";
} & GeneralMessage;

type RefreshMessage = {
	type: "refresh";
} & GeneralMessage;

type ReceivedMessage = {
	Sent: number;
	Data: GeneralMessage;
};

interface PoolEntry<T> {
	readonly ServerSource: string;
	readonly SentTime: number;
	readonly Value: T;
}

const thisServerId = game.JobId === "" ? "STUDIO" : game.JobId;

class Pool<T> {
	private readonly Contributions = new Map<HashKey, PoolEntry<T>>();
	private readonly ServerMap = new Map<string, Set<HashKey>>();
	private readonly MessageSubscription: RBXScriptConnection;
	// Event called with the entry, and whether it's new or not (true = new, false = update)
	public readonly ContributionChanged = new ObjectEvent<[T, boolean]>();
	// ContributionRemoved is called with the hashkey for the contribution
	// I'm not 100% happy with this API, but I'd like to see a use-case for
	// worrying about providing the contribution. If you have one, let's talk.
	public readonly ContributionRemoved = new ObjectEvent<[string]>();
	private currentRefresh = 0;

	constructor(
		private readonly name: string,
		private readonly hasher: Hasher<T>,
		private readonly serializer: Serializer<T>,
		private readonly deserializer: Deserializer<T>,
	) {
		const [subscribeSuccess, subscribeConnection] = pcall((_) => {
			return messagingService.SubscribeAsync(this.TopicName(), (message: ReceivedMessage) => {
				const type = message.Data.type;
				if (type === "set") {
					this.HandleSet(message.Sent, <SetMessage>message.Data);
				} else if (type === "remove") {
					this.HandleRemove(<RemoveMessage>message.Data);
				} else if (type === "clear") {
					this.HandleClear(<ClearMessage>message.Data);
				} else if (type === "refresh") {
					this.HandleRefresh(<RefreshMessage>message.Data);
				} else {
					throw `Unexpected message type ${message.Data.type} sent to the ${this.TopicName()} pool.`;
				}
			});
		});
		if (!subscribeSuccess) {
			throw `Failed to establish subscription to the ${this.TopicName()} MessagingService pool.`;
		}
		this.MessageSubscription = <RBXScriptConnection>subscribeConnection;

		game.BindToClose(() => this.EmptyContributions());

		// Ask the other servers to refresh their contributions so we find out about them
		const connection = pcall((_) => {
			return messagingService.PublishAsync(this.TopicName(), {
				type: "refresh",
				seid: thisServerId,
			});
		});
	}

	private TopicName(): string {
		return `POOL_${this.name}`;
	}

	private HandleSet(time: number, message: SetMessage) {
		const obj = this.deserializer(message.data);
		const key = this.hasher(obj);

		const existing = this.Contributions.get(key);
		if (existing !== undefined && existing.SentTime > time) {
			print(
				`Maintaining ${existing.ServerSource}'s authority over ${key} since it was declared before ${message.seid}'s message.`,
			);
			return;
		}

		this.Contributions.set(key, {
			ServerSource: message.seid,
			SentTime: time,
			Value: obj,
		});
		this.GetServerContributions(message.seid).add(key);
		let isNew = false;
		if (existing === undefined) {
			isNew = true;
		}
		this.ContributionChanged.Fire(obj, isNew);
	}

	private HandleRemove(message: RemoveMessage) {
		const existing = this.Contributions.get(message.key);
		if (existing === undefined) return;

		if (existing.ServerSource !== message.seid) {
			print(
				`Server ${message.seid} attempted to remove ${message.key}, but ${existing.ServerSource} is considered authoritative. Ignoring.`,
			);
			return;
		}

		this.GetServerContributions(message.seid).delete(message.key);
		this.Contributions.delete(message.key);
		this.ContributionRemoved.Fire(message.key);
	}

	private HandleClear(message: ClearMessage) {
		this.GetServerContributions(message.seid).forEach((contribution) => {
			this.Contributions.delete(contribution);
		});
		this.ServerMap.delete(message.seid);
	}

	// A refresh message is a request from another server for us to refresh its cache.
	// This can be optimised in future to batch messages together to send faster,
	// but until then we bottleneck sending rates (taking advantage of our loosely-defined
	// promise of eventual consistency) to make sure we don't hit any caps.
	private HandleRefresh(message: RefreshMessage) {
		const thisRefresh = ++this.currentRefresh;

		// Create a copy of the contributions we need to refresh we can traverse over
		const remainingContribs = new Set<HashKey>();
		this.GetServerContributions(thisServerId).forEach((key) => {
			remainingContribs.add(key);
		});

		for (const contrib of remainingContribs) {
			// If someone refreshes us again, we have to start from scratch, so quit the loop.
			// TODO: Clever order changing (random?) so we don't end up refreshing the same key
			// over and over if we get a lot of refresh requests
			if (thisRefresh !== this.currentRefresh) break;

			const key = contrib;
			remainingContribs.delete(key);
			const value = this.Contributions.get(key);
			if (value === undefined) {
				throw `Pool is in an inconsistent state; this server is marked as contributing ${key}, but it wasn't found in the Contributions.`;
			}

			this.ReplaceContribution(value.Value);

			// Delay pool catch-up to avoid bottlenecks. TODO: Something more clever
			wait(0.5);
		}
	}

	private GetServerContributions(serverId: string): Set<HashKey> {
		const existing = this.ServerMap.get(serverId);
		if (existing !== undefined) {
			return existing;
		}
		const serverSet = new Set<HashKey>();
		this.ServerMap.set(serverId, serverSet);
		return serverSet;
	}

	public GetAllContributions(): Array<T> {
		const contribs = new Array<T>();
		this.Contributions.forEach((c) => {
			contribs.push(c.Value);
		});
		return contribs;
	}

	public GetContribution(key: HashKey): T | undefined {
		return this.Contributions.get(key)?.Value;
	}

	public ReplaceContribution(contribution: T) {
		const [publishSuccess, publishResult] = pcall((_) => {
			return messagingService.PublishAsync(this.TopicName(), {
				type: "set",
				seid: thisServerId,
				data: this.serializer(contribution),
			});
		});
	}

	public RemoveContribution(contributionKey: HashKey) {
		const [removeSuccess, removeResult] = pcall((_) => {
			return messagingService.PublishAsync(this.TopicName(), {
				type: "remove",
				seid: thisServerId,
				key: contributionKey,
			});
		});
	}

	public EmptyContributions() {
		const [removeSuccess, removeResult] = pcall((_) => {
			return messagingService.PublishAsync(this.TopicName(), {
				type: "clear",
				seid: thisServerId,
			});
		});
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pools = new Map<string, Pool<any>>();

export function NumberPool(poolName: string): Pool<number> {
	return GeneralPool<number>(
		poolName,
		(a) => tostring(a),
		(a) => tostring(a),
		(s) => <number>tonumber(s),
	);
}

export function StringPool(poolName: string): Pool<string> {
	return GeneralPool<string>(
		poolName,
		(a) => a,
		(a) => a,
		(a) => a,
	);
}

// A JSONPool automatically serializes entries using HttpService's JSON encoding
// facilities. It is probably what you'll want to use most of the time.
export function JSONPool<T>(poolName: string, hasher: Hasher<T>): Pool<T> {
	return GeneralPool<T>(
		poolName,
		hasher,
		(p) => HttpService.JSONEncode(p),
		(p) => HttpService.JSONDecode(p),
	);
}

export function GeneralPool<T>(
	poolName: string,
	hasher: Hasher<T>,
	serializer: Serializer<T>,
	deserializer: Deserializer<T>,
): Pool<T> {
	if (pools.has(poolName)) {
		throw `A pool named ${poolName} is already registered; check your initialisation logic.`;
	}

	const pool = new Pool<T>(poolName, hasher, serializer, deserializer);
	pools.set(poolName, pool);
	return pool;
}
