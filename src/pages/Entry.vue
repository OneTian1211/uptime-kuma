<template>
    <div>
        <StatusPage v-if="statusPageSlug" :override-slug="statusPageSlug" />
    </div>
</template>

<script>
import axios from "axios";
import StatusPage from "./StatusPage.vue";

export default {
    components: {
        StatusPage,
    },
    data() {
        return {
            statusPageSlug: null,
        };
    },
    async mounted() {
        // Pre-connect the socket in parallel with the entry-page lookup so
        // that by the time we route to /dashboard the websocket handshake
        // has already happened, saving one round-trip of perceived latency.
        if (typeof this.$root.initSocketIO === "function") {
            this.$root.initSocketIO(true);
        }

        let res;
        try {
            res = (await axios.get("/api/entry-page")).data;

            if (res.type === "statusPageMatchedDomain") {
                this.statusPageSlug = res.statusPageSlug;
                this.$root.forceStatusPageTheme = true;
            } else if (res.type === "entryPage") {
                // Dev only. For production, the logic is in the server side
                const entryPage = res.entryPage;
                if (entryPage?.startsWith("statusPage-")) {
                    this.$router.push("/status/" + entryPage.replace("statusPage-", ""));
                } else {
                    this.$router.push("/dashboard");
                }
            } else if (res.type === "setup-database") {
                this.$router.push("/setup-database");
            } else {
                this.$router.push("/dashboard");
            }
        } catch (e) {
            alert("Cannot connect to the backend server. Did you start the backend server? (npm run start-server-dev)");
        }
    },
};
</script>
