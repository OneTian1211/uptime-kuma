import { io } from "socket.io-client";
import { useToast } from "vue-toastification";
import jwtDecode from "jwt-decode";
import Favico from "favico.js";
import dayjs from "dayjs";
import mitt from "mitt";

import { DOWN, MAINTENANCE, PENDING, UP } from "../util.ts";
import {
    getDevContainerServerHostname,
    isDevContainer,
    getToastSuccessTimeout,
    getToastErrorTimeout,
} from "../util-frontend.js";
const toast = useToast();

let socket;

const noSocketIOPages = [
    /^\/status-page$/, //  /status-page
    /^\/status/, // /status**
    /^\/$/, //  /
];

const favicon = new Favico({
    animation: "none",
});

export default {
    data() {
        return {
            info: {},
            socket: {
                token: null,
                firstConnect: true,
                connected: false,
                connectCount: 0,
                initedSocketIO: false,
            },
            username: null,
            remember: localStorage.remember !== "0",
            allowLoginDialog: false, // Allowed to show login dialog, but "loggedIn" have to be true too. This exists because prevent the login dialog show 0.1s in first before the socket server auth-ed.
            loggedIn: false,
            monitorList: {},
            monitorTypeList: {},
            maintenanceList: {},
            apiKeyList: {},
            heartbeatList: {},
            avgPingList: {},
            uptimeList: {},
            tlsInfoList: {},
            domainInfoList: {},
            notificationList: [],
            dockerHostList: [],
            remoteBrowserList: [],
            statusPageListLoaded: false,
            statusPageList: [],
            proxyList: [],
            subscribedMonitorIDs: new Set(),
            loadedGroupChildren: new Set(),
            // Quick-Stats aggregate pushed by the server before the paged
            // monitorList frames start arriving.  Falls back to the `stats`
            // computed once monitorList merging is complete.
            monitorSummary: null,
            // First page of important heartbeats + total count pushed by the
            // server right after login so the Dashboard event table renders
            // without the monitorImportantHeartbeatListCount/Paged round trips.
            importantHeartbeatsInitial: null,
            // Pages of monitorList frames received so far.  Used to deduplicate
            // retries / out-of-order delivery.
            loadedMonitorPages: new Set(),
            monitorListComplete: false,
            connectionErrorMsg: `${this.$t("Cannot connect to the socket server.")} ${this.$t("Reconnecting...")}`,
            showReverseProxyGuide: true,
            cloudflared: {
                cloudflareTunnelToken: "",
                installed: null,
                running: false,
                message: "",
                errorMessage: "",
                currentPassword: "",
            },
            faviconUpdateDebounce: null,
            emitter: mitt(),
        };
    },

    created() {
        this.initSocketIO();
    },

    mounted() {
        // Deep-link safety net: if the URL points to a child monitor that
        // has not yet been loaded into monitorList, subscribe so realtime
        // events still arrive even if its parent group is off-screen.
        this.subscribeCurrentRouteMonitor();
    },

    methods: {
        /**
         * Initialize connection to socket server
         * @param {boolean} bypass Should the check for if we
         * are on a status page be bypassed?
         * @returns {void}
         */
        initSocketIO(bypass = false) {
            // No need to re-init
            if (this.socket.initedSocketIO) {
                return;
            }

            // No need to connect to the socket.io for status page
            if (!bypass && location.pathname) {
                for (let page of noSocketIOPages) {
                    if (location.pathname.match(page)) {
                        return;
                    }
                }
            }

            // Also don't need to connect to the socket.io for setup database page
            if (location.pathname === "/setup-database") {
                return;
            }

            this.socket.initedSocketIO = true;

            let protocol = location.protocol + "//";

            let url;
            const env = process.env.NODE_ENV || "production";
            if (env === "development" && isDevContainer()) {
                url = protocol + getDevContainerServerHostname();
            } else if (env === "development" || localStorage.dev === "dev") {
                url = protocol + location.hostname + ":3001";
            } else {
                // Connect to the current url
                url = undefined;
            }

            socket = io(url);

            socket.on("info", (info) => {
                this.info = info;
            });

            socket.on("setup", (monitorID, data) => {
                this.$router.push("/setup");
            });

            socket.on("autoLogin", (monitorID, data) => {
                this.loggedIn = true;
                this.storage().token = "autoLogin";
                this.socket.token = "autoLogin";
                this.allowLoginDialog = false;
            });

            socket.on("loginRequired", () => {
                let token = this.storage().token;
                if (token && token !== "autoLogin") {
                    this.loginByToken(token);
                } else {
                    this.$root.storage().removeItem("token");
                    this.allowLoginDialog = true;
                }
            });

            socket.on("monitorSummary", (data) => {
                this.monitorSummary = data;
            });

            socket.on("monitorListPage", (data) => {
                if (!data || !data.monitors) {
                    return;
                }
                if (this.loadedMonitorPages.has(data.pageIndex)) {
                    return;
                }
                this.loadedMonitorPages.add(data.pageIndex);

                this.assignMonitorUrlParser(data.monitors);

                // First page: reset stale state (fresh login).
                if (data.pageIndex === 0) {
                    this.monitorList = {};
                    this.subscribedMonitorIDs = new Set();
                    this.loadedGroupChildren = new Set();
                    this.loadedMonitorPages = new Set();
                }

                Object.entries(data.monitors).forEach(([ monitorID, monitor ]) => {
                    this.monitorList[monitorID] = monitor;
                });

                // Subscribe only to root monitors in this page so realtime
                // heartbeat / uptime / avgPing / certInfo / domainInfo events
                // arrive as soon as the page is in.  Children are subscribed
                // lazily on group expand via getMonitorChildren.
                const rootIDs = Object.values(data.monitors)
                    .filter((m) => m.parent === null)
                    .map((m) => m.id);
                if (rootIDs.length > 0) {
                    this.subscribeMonitors(rootIDs);
                }
            });

            socket.on("monitorListComplete", () => {
                this.monitorListComplete = true;
                this.subscribeCurrentRouteMonitor();
            });

            socket.on("monitorList", (data) => {
                this.assignMonitorUrlParser(data);
                this.monitorList = data;

                // Fresh login payload: discard any stale subscription and
                // child-load tracking so the new session starts clean.
                this.subscribedMonitorIDs = new Set();
                this.loadedGroupChildren = new Set();
                this.loadedMonitorPages = new Set();
                this.monitorListComplete = true;

                // Subscribe to root monitors so we receive their realtime
                // heartbeat / uptime / avgPing / certInfo / domainInfo events.
                // Children are subscribed lazily on group expand.
                const rootIDs = Object.values(data)
                    .filter((m) => m.parent === null)
                    .map((m) => m.id);
                this.subscribeMonitors(rootIDs);

                // If the current URL is a deep link into a child monitor
                // (e.g. /dashboard/123) and it is not in the root list,
                // subscribe to it so realtime events still arrive.
                this.subscribeCurrentRouteMonitor();
            });

            socket.on("updateMonitorIntoList", (data) => {
                this.assignMonitorUrlParser(data);
                Object.entries(data).forEach(([monitorID, updatedMonitor]) => {
                    this.monitorList[monitorID] = updatedMonitor;
                });
                this.subscribeMonitors(Object.keys(data).map((id) => parseInt(id)));
            });

            socket.on("deleteMonitorFromList", (monitorID) => {
                if (this.monitorList[monitorID]) {
                    delete this.monitorList[monitorID];
                }
                const numID = parseInt(monitorID);
                if (Number.isInteger(numID)) {
                    this.unsubscribeMonitors([numID]);
                }
            });

            socket.on("monitorTypeList", (data) => {
                this.monitorTypeList = data;
            });

            socket.on("maintenanceList", (data) => {
                this.maintenanceList = data;
            });

            socket.on("apiKeyList", (data) => {
                this.apiKeyList = data;
            });

            socket.on("notificationList", (data) => {
                this.notificationList = data;
            });

            socket.on("statusPageList", (data) => {
                this.statusPageListLoaded = true;
                this.statusPageList = data;
            });

            socket.on("proxyList", (data) => {
                this.proxyList = data.map((item) => {
                    item.auth = !!item.auth;
                    item.active = !!item.active;
                    item.default = !!item.default;

                    return item;
                });
            });

            socket.on("dockerHostList", (data) => {
                this.dockerHostList = data;
            });

            socket.on("remoteBrowserList", (data) => {
                this.remoteBrowserList = data;
            });

            socket.on("heartbeat", (data) => {
                if (!(data.monitorID in this.heartbeatList)) {
                    this.heartbeatList[data.monitorID] = [];
                }

                this.heartbeatList[data.monitorID].push(data);

                if (this.heartbeatList[data.monitorID].length >= 150) {
                    this.heartbeatList[data.monitorID].shift();
                }

                // Add to important list if it is important
                // Also toast
                if (data.important) {
                    if (this.monitorList[data.monitorID] !== undefined) {
                        if (data.status === 0) {
                            toast.error(`[${this.monitorList[data.monitorID].name}] [DOWN] ${data.msg}`, {
                                timeout: getToastErrorTimeout(),
                            });
                        } else if (data.status === 1) {
                            toast.success(`[${this.monitorList[data.monitorID].name}] [Up] ${data.msg}`, {
                                timeout: getToastSuccessTimeout(),
                            });
                        } else {
                            toast(`[${this.monitorList[data.monitorID].name}] ${data.msg}`);
                        }
                    }

                    this.emitter.emit("newImportantHeartbeat", data);
                }
            });

            // Batch arrival of the latest heartbeat for each root monitor,
            // sent once right after login so the dashboard Quick Stats counters
            // populate immediately. Each monitor's heartbeatList temporarily
            // holds a 1-element array; the subsequent heartbeatList event with
            // overwrite=true replaces it with the full history.
            socket.on("lastHeartbeatBatch", (batch) => {
                for (const monitorID in batch) {
                    this.heartbeatList[monitorID] = batch[monitorID];
                }
            });

            socket.on("importantHeartbeatsInitial", (data) => {
                this.importantHeartbeatsInitial = data;
            });

            socket.on("heartbeatList", (monitorID, data, overwrite = false) => {
                if (!(monitorID in this.heartbeatList) || overwrite) {
                    this.heartbeatList[monitorID] = data;
                } else {
                    this.heartbeatList[monitorID] = data.concat(this.heartbeatList[monitorID]);
                }
            });

            socket.on("avgPing", (monitorID, data) => {
                this.avgPingList[monitorID] = data;
            });

            socket.on("uptime", (monitorID, type, data) => {
                this.uptimeList[`${monitorID}_${type}`] = data;
            });

            socket.on("certInfo", (monitorID, data) => {
                this.tlsInfoList[monitorID] = JSON.parse(data);
            });

            socket.on("domainInfo", (monitorID, daysRemaining, expiresOn) => {
                this.domainInfoList[monitorID] = { daysRemaining: daysRemaining, expiresOn: expiresOn };
            });

            socket.on("connect_error", (err) => {
                console.error(`Failed to connect to the backend. Socket.io connect_error: ${err.message}`);
                this.connectionErrorMsg = `${this.$t("Cannot connect to the socket server.")} [${err}] ${this.$t("Reconnecting...")}`;
                this.showReverseProxyGuide = true;
                this.socket.connected = false;
                this.socket.firstConnect = false;
            });

            socket.on("disconnect", () => {
                console.log("disconnect");
                this.connectionErrorMsg = `${this.$t("Lost connection to the socket server.")} ${this.$t("Reconnecting...")}`;
                this.socket.connected = false;
            });

            socket.on("connect", () => {
                console.log("Connected to the socket server");
                this.socket.connectCount++;
                this.socket.connected = true;
                this.showReverseProxyGuide = false;

                // Reset Heartbeat list if it is re-connect
                if (this.socket.connectCount >= 2) {
                    this.clearData();
                }

                this.socket.firstConnect = false;
            });

            // cloudflared
            socket.on("cloudflared_installed", (res) => (this.cloudflared.installed = res));
            socket.on("cloudflared_running", (res) => (this.cloudflared.running = res));
            socket.on("cloudflared_message", (res) => (this.cloudflared.message = res));
            socket.on("cloudflared_errorMessage", (res) => (this.cloudflared.errorMessage = res));
            socket.on("cloudflared_token", (res) => (this.cloudflared.cloudflareTunnelToken = res));

            socket.on("initServerTimezone", () => {
                socket.emit("initServerTimezone", dayjs.tz.guess());
            });

            socket.on("refresh", () => {
                location.reload();
            });
        },
        /**
         * parse all urls from list.
         * @param {object} data Monitor data to modify
         * @returns {object} list
         */
        assignMonitorUrlParser(data) {
            Object.entries(data).forEach(([monitorID, monitor]) => {
                monitor.getUrl = () => {
                    try {
                        return new URL(monitor.url);
                    } catch (_) {
                        return null;
                    }
                };
            });
            return data;
        },

        /**
         * The storage currently in use
         * @returns {Storage} Current storage
         */
        storage() {
            return this.remember ? localStorage : sessionStorage;
        },

        /**
         * Get payload of JWT cookie
         * @returns {(object | undefined)} JWT payload
         */
        getJWTPayload() {
            const jwtToken = this.$root.storage().token;

            if (jwtToken && jwtToken !== "autoLogin") {
                return jwtDecode(jwtToken);
            }
            return undefined;
        },

        /**
         * Get current socket
         * @returns {Socket} Current socket
         */
        getSocket() {
            return socket;
        },

        /**
         * Apply translation to a message if possible
         * @param {string | {key: string, values: object}} msg Message to translate
         * @returns {string} Translated message
         */
        applyTranslation(msg) {
            if (msg != null && typeof msg === "object") {
                return this.$t(msg.key, msg.values);
            } else {
                return this.$t(msg);
            }
        },

        /**
         * Show success or error toast dependent on response status code
         * @param {{ok:boolean, msg: string, msgi18n: false} | {ok:boolean, msg: string|{key: string, values: object}, msgi18n: true}} res Response object
         * @returns {void}
         */
        toastRes(res) {
            if (res.msgi18n) {
                res.msg = this.applyTranslation(res.msg);
            }

            if (res.ok) {
                toast.success(res.msg);
            } else {
                toast.error(res.msg);
            }
        },

        /**
         * Show a success toast
         * @param {string} msg Message to show
         * @returns {void}
         */
        toastSuccess(msg) {
            toast.success(this.$t(msg));
        },

        /**
         * Show an error toast
         * @param {string} msg Message to show
         * @returns {void}
         */
        toastError(msg) {
            toast.error(this.$t(msg));
        },

        /**
         * Callback for login
         * @callback loginCB
         * @param {object} res Response object
         */

        /**
         * Send request to log user in
         * @param {string} username Username to log in with
         * @param {string} password Password to log in with
         * @param {string} token User token
         * @param {loginCB} callback Callback to call with result
         * @returns {void}
         */
        login(username, password, token, callback) {
            socket.emit(
                "login",
                {
                    username,
                    password,
                    token,
                },
                (res) => {
                    if (res.tokenRequired) {
                        callback(res);
                    }

                    if (res.ok) {
                        this.storage().token = res.token;
                        this.socket.token = res.token;
                        this.loggedIn = true;
                        this.username = this.getJWTPayload()?.username;

                        // Trigger Chrome Save Password
                        history.pushState({}, "");
                    }

                    callback(res);
                }
            );
        },

        /**
         * Log in using a token
         * @param {string} token Token to log in with
         * @returns {void}
         */
        loginByToken(token) {
            socket.emit("loginByToken", token, (res) => {
                this.allowLoginDialog = true;

                if (!res.ok) {
                    this.logout();
                } else {
                    this.loggedIn = true;
                    this.username = this.getJWTPayload()?.username;
                }
            });
        },

        /**
         * Log out of the web application
         * @returns {void}
         */
        logout() {
            socket.emit("logout", () => {});
            this.storage().removeItem("token");
            this.socket.token = null;
            this.loggedIn = false;
            this.username = null;
            this.clearData();
        },

        /**
         * Callback for general socket requests
         * @callback socketCB
         * @param {object} res Result of operation
         */
        /**
         * Prepare 2FA configuration
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        prepare2FA(callback) {
            socket.emit("prepare2FA", callback);
        },

        /**
         * Save the current 2FA configuration
         * @param {any} secret Unused
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        save2FA(secret, callback) {
            socket.emit("save2FA", callback);
        },

        /**
         * Disable 2FA for this user
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        disable2FA(callback) {
            socket.emit("disable2FA", callback);
        },

        /**
         * Verify the provided 2FA token
         * @param {string} token Token to verify
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        verifyToken(token, callback) {
            socket.emit("verifyToken", token, callback);
        },

        /**
         * Get current 2FA status
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        twoFAStatus(callback) {
            socket.emit("twoFAStatus", callback);
        },

        /**
         * Get list of monitors
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        getMonitorList(callback) {
            if (!callback) {
                callback = () => {};
            }
            socket.emit("getMonitorList", callback);
        },

        /**
         * Subscribe this socket to realtime events for the given monitor IDs.
         * Idempotent: IDs already subscribed are skipped.
         * @param {number[]} monitorIDs Array of monitor IDs to subscribe to
         * @returns {void}
         */
        subscribeMonitors(monitorIDs) {
            if (!Array.isArray(monitorIDs) || monitorIDs.length === 0) {
                return;
            }
            const newIDs = monitorIDs.filter((id) => !this.subscribedMonitorIDs.has(id));
            if (newIDs.length === 0) {
                return;
            }
            newIDs.forEach((id) => this.subscribedMonitorIDs.add(id));
            socket.emit("subscribeMonitors", newIDs, (res) => {
                if (!res || !res.ok) {
                    newIDs.forEach((id) => this.subscribedMonitorIDs.delete(id));
                }
            });
        },

        /**
         * Unsubscribe this socket from realtime events for the given monitor IDs.
         * @param {number[]} monitorIDs Array of monitor IDs to unsubscribe from
         * @returns {void}
         */
        unsubscribeMonitors(monitorIDs) {
            if (!Array.isArray(monitorIDs) || monitorIDs.length === 0) {
                return;
            }
            const existingIDs = monitorIDs.filter((id) => this.subscribedMonitorIDs.has(id));
            if (existingIDs.length === 0) {
                return;
            }
            existingIDs.forEach((id) => this.subscribedMonitorIDs.delete(id));
            socket.emit("unsubscribeMonitors", existingIDs, (res) => {
                if (!res || !res.ok) {
                    existingIDs.forEach((id) => this.subscribedMonitorIDs.add(id));
                }
            });
        },

        /**
         * Fetch children of a group monitor and merge them into monitorList.
         * Auto-subscribes the socket to each returned child for realtime events.
         * Marks the parent group as loaded on success so subsequent expand/collapse
         * toggles skip the request.
         * @param {number} parentID ID of the parent (group) monitor
         * @param {socketCB} callback Optional callback receiving { ok, list, ... }
         * @returns {void}
         */
        getMonitorChildren(parentID, callback) {
            socket.emit("getMonitorChildren", parentID, (res) => {
                if (res && res.ok && res.list) {
                    this.assignMonitorUrlParser(res.list);
                    Object.entries(res.list).forEach(([id, monitor]) => {
                        this.monitorList[id] = monitor;
                    });
                    this.subscribeMonitors(Object.keys(res.list).map((id) => parseInt(id)));
                    this.loadedGroupChildren.add(parentID);
                }
                if (typeof callback === "function") {
                    callback(res);
                }
            });
        },

        /**
         * Subscribe to the monitor referenced by the current route, if any.
         * Acts as a deep-link safety net so that realtime events for a child
         * monitor are delivered even when its parent group is not yet
         * expanded or not in the virtual scroller viewport.
         * @param {string|number} id Optional route id; defaults to current route
         * @returns {void}
         */
        subscribeCurrentRouteMonitor(id) {
            const routeID = id !== undefined ? id : this.$route?.params?.id;
            if (routeID === undefined || routeID === null || routeID === "") {
                return;
            }
            const numID = parseInt(routeID);
            if (!Number.isInteger(numID)) {
                return;
            }
            this.subscribeMonitors([numID]);
        },

        /**
         * Get list of maintenances
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        getMaintenanceList(callback) {
            if (!callback) {
                callback = () => {};
            }
            socket.emit("getMaintenanceList", callback);
        },

        /**
         * Send list of API keys
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        getAPIKeyList(callback) {
            if (!callback) {
                callback = () => {};
            }
            socket.emit("getAPIKeyList", callback);
        },

        /**
         * Add a monitor
         * @param {object} monitor Object representing monitor to add
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        add(monitor, callback) {
            socket.emit("add", monitor, callback);
        },

        /**
         * Adds a maintenance
         * @param {object} maintenance Maintenance to add
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        addMaintenance(maintenance, callback) {
            socket.emit("addMaintenance", maintenance, callback);
        },

        /**
         * Add monitors to maintenance
         * @param {number} maintenanceID Maintenance to modify
         * @param {number[]} monitors IDs of monitors to add
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        addMonitorMaintenance(maintenanceID, monitors, callback) {
            socket.emit("addMonitorMaintenance", maintenanceID, monitors, callback);
        },

        /**
         * Add status page to maintenance
         * @param {number} maintenanceID Maintenance to modify
         * @param {number} statusPages ID of status page to add
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        addMaintenanceStatusPage(maintenanceID, statusPages, callback) {
            socket.emit("addMaintenanceStatusPage", maintenanceID, statusPages, callback);
        },

        /**
         * Get monitors affected by maintenance
         * @param {number} maintenanceID Maintenance to read
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        getMonitorMaintenance(maintenanceID, callback) {
            socket.emit("getMonitorMaintenance", maintenanceID, callback);
        },

        /**
         * Get status pages where maintenance is shown
         * @param {number} maintenanceID Maintenance to read
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        getMaintenanceStatusPage(maintenanceID, callback) {
            socket.emit("getMaintenanceStatusPage", maintenanceID, callback);
        },

        /**
         * Delete monitor by ID
         * @param {number} monitorID ID of monitor to delete
         * @param {boolean} deleteChildren Whether to delete child monitors (for groups)
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        deleteMonitor(monitorID, deleteChildren, callback) {
            socket.emit("deleteMonitor", monitorID, deleteChildren, callback);
        },

        /**
         * Delete specified maintenance
         * @param {number} maintenanceID Maintenance to delete
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        deleteMaintenance(maintenanceID, callback) {
            socket.emit("deleteMaintenance", maintenanceID, callback);
        },

        /**
         * Add an API key
         * @param {object} key API key to add
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        addAPIKey(key, callback) {
            socket.emit("addAPIKey", key, callback);
        },

        /**
         * Delete specified API key
         * @param {int} keyID ID of key to delete
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        deleteAPIKey(keyID, callback) {
            socket.emit("deleteAPIKey", keyID, callback);
        },

        /**
         * Clear the hearbeat list
         * @returns {void}
         */
        clearData() {
            console.log("reset heartbeat list");
            this.heartbeatList = {};
        },

        /**
         * Upload the provided backup
         * @param {string} uploadedJSON JSON to upload
         * @param {string} importHandle Type of import. If set to
         * most data in database will be replaced
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        uploadBackup(uploadedJSON, importHandle, callback) {
            socket.emit("uploadBackup", uploadedJSON, importHandle, callback);
        },

        /**
         * Clear events for a specified monitor
         * @param {number} monitorID ID of monitor to clear
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        clearEvents(monitorID, callback) {
            socket.emit("clearEvents", monitorID, callback);
        },

        /**
         * Clear the heartbeats of a specified monitor
         * @param {number} monitorID Id of monitor to clear
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        clearHeartbeats(monitorID, callback) {
            socket.emit("clearHeartbeats", monitorID, callback);
        },

        /**
         * Clear all statistics
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        clearStatistics(callback) {
            socket.emit("clearStatistics", callback);
        },

        /**
         * Get monitor beats for a specific monitor in a time range
         * @param {number} monitorID ID of monitor to fetch
         * @param {number} period Time in hours from now
         * @param {socketCB} callback Callback for socket response
         * @returns {void}
         */
        getMonitorBeats(monitorID, period, callback) {
            socket.emit("getMonitorBeats", monitorID, period, callback);
        },

        /**
         * Retrieves monitor chart data.
         * @param {string} monitorID - The ID of the monitor.
         * @param {number} period - The time period for the chart data, in hours.
         * @param {socketCB} callback - The callback function to handle the chart data.
         * @returns {void}
         */
        getMonitorChartData(monitorID, period, callback) {
            socket.emit("getMonitorChartData", monitorID, period, callback);
        },
    },

    computed: {
        usernameFirstChar() {
            if (typeof this.username == "string" && this.username.length >= 1) {
                return this.username.charAt(0).toUpperCase();
            } else {
                return "🐻";
            }
        },

        lastHeartbeatList() {
            let result = {};

            for (let monitorID in this.heartbeatList) {
                let index = this.heartbeatList[monitorID].length - 1;
                result[monitorID] = this.heartbeatList[monitorID][index];
            }

            return result;
        },

        statusList() {
            let result = {};

            let unknown = {
                text: this.$t("Unknown"),
                color: "secondary",
            };

            for (let monitorID in this.lastHeartbeatList) {
                let lastHeartBeat = this.lastHeartbeatList[monitorID];

                if (!lastHeartBeat) {
                    result[monitorID] = unknown;
                } else if (lastHeartBeat.status === UP) {
                    result[monitorID] = {
                        text: this.$t("Up"),
                        color: "primary",
                    };
                } else if (lastHeartBeat.status === DOWN) {
                    result[monitorID] = {
                        text: this.$t("Down"),
                        color: "danger",
                    };
                } else if (lastHeartBeat.status === PENDING) {
                    result[monitorID] = {
                        text: this.$t("Pending"),
                        color: "warning",
                    };
                } else if (lastHeartBeat.status === MAINTENANCE) {
                    result[monitorID] = {
                        text: this.$t("statusMaintenance"),
                        color: "maintenance",
                    };
                } else {
                    result[monitorID] = unknown;
                }
            }

            return result;
        },

        stats() {
            // Prefer the server-precomputed snapshot for instant render.
            // Fall back to the live iteration once monitorList merging is
            // complete (which keeps the counts reactive to new heartbeats).
            if (this.monitorSummary && !this.monitorListComplete) {
                return {
                    active: this.monitorSummary.active,
                    up: this.monitorSummary.up,
                    down: this.monitorSummary.down,
                    maintenance: this.monitorSummary.maintenance,
                    pending: this.monitorSummary.pending,
                    unknown: this.monitorSummary.unknown,
                    pause: this.monitorSummary.pause,
                };
            }

            let result = {
                active: 0,
                up: 0,
                down: 0,
                maintenance: 0,
                pending: 0,
                unknown: 0,
                pause: 0,
            };

            for (let monitorID in this.$root.monitorList) {
                let beat = this.$root.lastHeartbeatList[monitorID];
                let monitor = this.$root.monitorList[monitorID];

                if (monitor && !monitor.active) {
                    result.pause++;
                } else if (beat) {
                    result.active++;
                    if (beat.status === UP) {
                        result.up++;
                    } else if (beat.status === DOWN) {
                        result.down++;
                    } else if (beat.status === PENDING) {
                        result.pending++;
                    } else if (beat.status === MAINTENANCE) {
                        result.maintenance++;
                    } else {
                        result.unknown++;
                    }
                } else {
                    result.unknown++;
                }
            }

            return result;
        },

        /**
         *  Frontend Version
         *  It should be compiled to a static value while building the frontend.
         *  Please see ./config/vite.config.js, it is defined via vite.js
         * @returns {string} Current version
         */
        frontendVersion() {
            // eslint-disable-next-line no-undef
            return FRONTEND_VERSION;
        },

        /**
         * Are both frontend and backend in the same version?
         * @returns {boolean} The frontend and backend match?
         */
        isFrontendBackendVersionMatched() {
            if (!this.info.version) {
                return true;
            }
            return this.info.version === this.frontendVersion;
        },
    },

    watch: {
        // Update Badge
        "stats.down"(to, from) {
            if (to !== from) {
                if (this.faviconUpdateDebounce != null) {
                    clearTimeout(this.faviconUpdateDebounce);
                }
                this.faviconUpdateDebounce = setTimeout(() => {
                    favicon.badge(to);
                }, 1000);
            }
        },

        // Reload the SPA if the server version is changed.
        "info.version"(to, from) {
            if (from && from !== to) {
                window.location.reload();
            }
        },

        remember() {
            localStorage.remember = this.remember ? "1" : "0";
        },

        // Reconnect the socket io, if status-page to dashboard
        "$route.fullPath"(newValue, oldValue) {
            if (newValue) {
                for (let page of noSocketIOPages) {
                    if (newValue.match(page)) {
                        return;
                    }
                }
            }

            this.initSocketIO();
        },

        // Deep-link safety net: subscribe to the route's monitor ID whenever
        // the URL changes so realtime events for deep-linked children arrive
        // even if their parent group is off-screen.
        "$route.params.id"(id) {
            this.subscribeCurrentRouteMonitor(id);
        },
    },
};
