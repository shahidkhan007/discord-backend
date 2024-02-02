import cors from "cors";
import express, { NextFunction, Request, Response, Router, json } from "express";
import { createServer } from "http";
import { join } from "path";
import { Server, Socket } from "socket.io";

const logger = (req: Request, res: Response, next: NextFunction) => {
    console.log(`[${req.method}] ${req.path}`);
    next();
};

const PING_INTERVAL = 5000;
const PING_TIMEOUT = 1000;

const app = express();
const server = createServer(app);
const io = new Server(server, {
    allowEIO3: true,
    transports: ["websocket", "polling"],
    cors: { origin: "http://127.0.0.1:3000" },
    pingInterval: PING_INTERVAL,
    pingTimeout: PING_TIMEOUT,
});

app.use(logger);
app.use(json());
app.use(cors({ origin: "http://127.0.0.1:3000" }));

const apiRouter = Router();

app.use("/api", apiRouter);

enum UserRole {
    Host = "Host",
    Viewer = "Viewer",
}

type Profile = {
    id: string;
    name: string;
    role: UserRole;
};

type User = {
    profile: Profile;
    socket: Socket;
};

let users: User[] = [];

const getHost = () => {
    for (const user of users) {
        if (user.profile.role == UserRole.Host) {
            return user;
        }
    }
    return null;
};

const getUser = (profile: Profile) => {
    for (const user of users) {
        if (user.profile.id === profile.id) {
            return user;
        }
    }
    return null;
};

const sleep = (ms: number): Promise<void> => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, ms);
    });
};

const createUser = async (socket: Socket, profile: Profile) => {
    console.log(`Create user request for '${profile.name} (${profile.role})'`);

    if (profile.role === UserRole.Host) {
        console.log("Create host request");
        // Create host request
        const host = getHost();
        console.log(host, profile, users);
        if (host) {
            console.log("Host already exists");
            // Host already exits
            // Check for stale

            if (host.profile.id === profile.id) {
                host.socket.disconnect(true);
                host.socket = socket;
                return;
            }

            await sleep(PING_INTERVAL + PING_TIMEOUT);
            if (host.socket.connected) {
                // Current host is active, deny new host
                console.log("Host is active");
                socket.emit("host-already-exists", { profile, hostProfile: host.profile });
            } else {
                // Unreachable
                console.log("Host is stale");
                // Stale host, create new host
                host.socket.disconnect(true);
                host.profile = profile;
                host.socket = socket;
            }
        } else {
            console.log("No host, create new");
            // No host exists, create new host
            const newHost = { socket, profile };
            users.push(newHost);
            socket.emit("user-created", "");
        }
    } else {
        console.log("Create user");
        // Create user request
        const user = getUser(profile);
        if (user) {
            // User already exists, renew the socket
            user.socket.disconnect(true);
            user.socket = socket;
        } else {
            users.push({ socket, profile });
            socket.emit("user-created", "");
        }
    }
};

const createConnection = (profile: Profile) => {
    console.log(`Create connection request by: '${profile.name}'`);
    const host = getHost();
    if (!host) {
        console.log("Host not found, denying");
        const user = getUser(profile);
        if (user) {
            user.socket.emit("no-host", { profile });
        }
        return;
    }
    console.log("Host notified of the new connection request");
    host.socket.emit("create-connection", profile);
};

const sendSDP = (profile: Profile, sdp: any) => {
    console.log("Sending SDP to", profile.name);
    const user = getUser(profile);

    if (!user) {
        console.log("Target user not found", users);
        return;
    }
    user.socket.emit("sdp", { profile, sdp });
};

const sendAnswer = (profile: Profile, answer: any) => {
    const host = getHost();
    if (!host) {
        return;
    }
    host.socket.emit("answer", { answer, profile });
};

const sendIceCandidate = (profile: Profile, candidate: any, viewerProfile?: Profile) => {
    let target = null;
    if (viewerProfile) {
        target = getUser(viewerProfile);
    } else {
        target = getHost();
    }
    if (target) {
        target.socket.emit("iceCandidate", { profile: viewerProfile ?? profile, candidate });
        console.log("sending ice candidate from", profile, "to", target.profile);
    }
};

io.on("connection", async (socket) => {
    console.log(`User connected: ID: ${socket.id}`);
    socket.on("create-user", (profile) => createUser(socket, profile));
    socket.on("create-connection", (profile) => createConnection(profile));
    socket.on("sdp", ({ profile, sdp }) => sendSDP(profile, sdp));
    socket.on("answer", ({ profile, answer }) => sendAnswer(profile, answer));
    socket.on("ice", ({ profile, candidate, viewer }) =>
        sendIceCandidate(profile, candidate, viewer)
    );
    socket.on("disconnect", (reason, description) => {
        console.log("Socket disconnected. Reason:", reason);
        for (const user of users) {
            if (user.socket.id === socket.id) {
                users = users.filter((u) => u.profile.id !== user.profile.id);
                break;
            }
        }
        socket.disconnect(true);
    });
});

app.use(express.static("public"));

apiRouter.get("/host", (req, res) => {
    const host = getHost();
    console.log("Current host", host, users);

    return res.json({ profile: host?.profile ?? null });
});

app.get("*", (req, res) => {
    return res.sendFile(join(__dirname, "../public", "index.html"));
});

server.listen(4241, () => {
    console.log(`Server started at port 4241`);
});
