# data-pooler

data-pooler is a library for handling inter-server data aggregation in Roblox, written in TypeScript.

## What does it do?

data-pooler allows you to define `Pool`s, which allow all Roblox servers within the same game to aggregate
portions of information which is automatically shared amongst them to form an eventually-consistent
global set of information on every server.

For example, if you want to know all of the players playing your game, each server has a portion of the
overall information, and collectively they know all of the information. Pools allow you to easily
merge all of this information together without delving into networking code yourself.

Underneath the hood, this library uses `MessagingService` to communicate between servers.

## Current issues

There are a few current issues with data-pooler you should consider before using `data-pooler` in a
production game. They're documented [as GitHub issues](https://github.com/ashleydavies/data-pooler/issues).

Pull requests are entirely welcome to solve these, and any other, issues.

## Installing

If you have an [roblox-ts](https://roblox-ts.com) environment set up, you can use NPM or Yarn to install this:

```bash
npm i @rbxts/data-pooler
```

```bash
yarn add @rbxts/data-pooler
```

If you're not sure which you use, check if you have a `package-lock.json` or a `yarn.lock` file. The former
is from `npm` and the latter is from `yarn`.

## Usage

A pool can share any type of data, whether it be simple strings or tables of information, as long as
it serializes to a bit less than 1Kb (limitation of `MessagingService`, plus `data-pooler`
includes some bytes of metadata).

A pool requires a few properties:

1. A name
2. A "hashing function", which converts the data you are storing into the pool to a unique string that
   represents an entry in the pool. This might be an ID or even just the data itself if it's short.
3. A serialization function, which converts your data into a string.
4. A deserialization function, which reverts the serialization.

Existing functions have already been defined for two common cases - string pools and number pools.

### String example

To create a `Pool` that allows you to maintain a list of all players in your game in any server,
you can use a simple `StringPool` with the usernames of each player:

```typescript
import { StringPool } from "@rbxts/data-pooler";

const PlayerPool = StringPool("Players");

PlayerService.PlayerAdded.Connect((p) => {
    PlayerPool.ReplaceContribution(p.Name);
});
PlayerService.PlayerRemoving.Connect((p) => {
    PlayerPool.RemoveContribution(p.Name);
});

// Catch up with any players who joined before this script
// set up event hooks
PlayerService.GetPlayers().forEach((player) => {
    PlayerPool.ReplaceContribution(player.Name);
});

// ...

// Anywhere you want to know about all of the players
print(PlayerPool.GetAllContributions())
// > ["username-from-this-server", "username-from-other-server"]
```

We refer to a piece of information within a pool as a "contribution".
Each contribution is "owned" by the server that most recently contributed it,
and only that server is able to withdraw the contribution, to prevent against
cases where one server contributes information, and later removes it, but
the removal message was received after another server contributed it.

To add or update a contribution, you use the `ReplaceContribution` method, which
takes a contribution to the pool and automatically informs all servers of it. You
can later remove this contribution with `RemoveContribution`.

When a server closes, all contributions are automatically removed, as long as
the server shuts down gracefully and the `game:BindToClose` event is triggered.

### Usage as a volatile information store

You can use pools together with `DataStore` to create a two-pronged approach
to sharing information: pools are a volatile, fast way to inform other servers
of immediate changes, whilst `DataStore` is best for persisting those changes.

For example, you may ban users by saving their usernames to `DataStore`, as well
as immediately adding their usernames to a `BannedUsers` pool, which prevents
them being able to join other servers due to `DataStore` caching.

### More sophisticated example

**Until message throttling is implemented, you will not want to use
an example like this which is likely to have high frequency updates,
unless you implement your own throttling around the Pool. See the current
issues section above for more information. This is just a demonstration of
how to do something more complex.**

```typescript
const HTTPService = game.GetService("HttpService");

type LeaderboardEntry = {
    username: string;
    points: number;
};

const LeaderboardPool = GeneralPool<LeaderboardEntry>(
    "Leaderboard",
    // A leaderboard entry hashes to just its username, which is the unique key for a single
    // entry. I.e. if a new entry is added to the pool with the same username, it overwrites
    // any old entry with the same username.
    (e) => e.username,
    // A leaderboard entry can be serialized with JSONEncode
    (e) => HTTPService.JSONEncode(e),
    // ... and deserialized with JSONDecode
    (s) => <LeaderboardEntry>HTTPService.JSONDecode(s),
);

const InitialisePlayerInPool = (p: Player) => {
    LeaderboardPool.ReplaceContribution({
        username: p.Name,
        points: 0,
    });
};

PlayerService.PlayerAdded.Connect(InitialisePlayerInPool);
PlayerService.PlayerRemoving.Connect((p) => {
    // You remove from a pool by the hashed key, so we only use their username
    LeaderboardPool.RemoveContribution(p.Name);
});

// Catch up with any existing players
PlayerService.GetPlayers().forEach(InitialisePlayerInPool);

function GetPoints(player): number | undefined {
    return LeaderboardPool.GetContribution(player)?.points;
}

function AwardPoints(player, points) {
    LeaderboardPool.ReplaceContribution({
        username: player.username,
        points: (GetPoints(player) || 0) + points,
    });
}
```
