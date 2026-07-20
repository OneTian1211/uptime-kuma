import { createRouter, createWebHistory } from "vue-router";

import EmptyLayout from "./layouts/EmptyLayout.vue";
import Layout from "./layouts/Layout.vue";
import Dashboard from "./pages/Dashboard.vue";
import DashboardHome from "./pages/DashboardHome.vue";
import Entry from "./pages/Entry.vue";

const Details = () => import("./pages/Details.vue");
const EditMonitor = () => import("./pages/EditMonitor.vue");
const EditMaintenance = () => import("./pages/EditMaintenance.vue");
const List = () => import("./pages/List.vue");
const Settings = () => import("./pages/Settings.vue");
const Setup = () => import("./pages/Setup.vue");
const StatusPage = () => import("./pages/StatusPage.vue");
const ManageStatusPage = () => import("./pages/ManageStatusPage.vue");
const AddStatusPage = () => import("./pages/AddStatusPage.vue");
const NotFound = () => import("./pages/NotFound.vue");
const ManageMaintenance = () => import("./pages/ManageMaintenance.vue");
const SetupDatabase = () => import("./pages/SetupDatabase.vue");

// Settings - Sub Pages
const DockerHosts = () => import("./components/settings/Docker.vue");
const APIKeys = () => import("./components/settings/APIKeys.vue");
const Appearance = () => import("./components/settings/Appearance.vue");
const General = () => import("./components/settings/General.vue");
const Notifications = () => import("./components/settings/Notifications.vue");
const ReverseProxy = () => import("./components/settings/ReverseProxy.vue");
const Tags = () => import("./components/settings/Tags.vue");
const MonitorHistory = () => import("./components/settings/MonitorHistory.vue");
const Security = () => import("./components/settings/Security.vue");
const Proxies = () => import("./components/settings/Proxies.vue");
const About = () => import("./components/settings/About.vue");
const RemoteBrowsers = () => import("./components/settings/RemoteBrowsers.vue");

const routes = [
    {
        path: "/",
        component: Entry,
    },
    {
        // If it is "/dashboard", the active link is not working
        // If it is "", it overrides the "/" unexpectedly
        // Give a random name to solve the problem.
        path: "/empty",
        component: Layout,
        children: [
            {
                path: "",
                component: Dashboard,
                children: [
                    {
                        name: "DashboardHome",
                        path: "/dashboard",
                        component: DashboardHome,
                        children: [
                            {
                                path: "/dashboard/:id",
                                component: EmptyLayout,
                                children: [
                                    {
                                        path: "",
                                        component: Details,
                                    },
                                    {
                                        path: "/edit/:id",
                                        component: EditMonitor,
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        path: "/add",
                        component: EditMonitor,
                        children: [
                            {
                                path: "/clone/:id",
                                component: EditMonitor,
                            },
                        ],
                    },
                    {
                        path: "/list",
                        component: List,
                    },
                    {
                        path: "/settings",
                        component: Settings,
                        children: [
                            {
                                path: "general",
                                component: General,
                            },
                            {
                                path: "appearance",
                                component: Appearance,
                            },
                            {
                                path: "notifications",
                                component: Notifications,
                            },
                            {
                                path: "reverse-proxy",
                                component: ReverseProxy,
                            },
                            {
                                path: "tags",
                                component: Tags,
                            },
                            {
                                path: "monitor-history",
                                component: MonitorHistory,
                            },
                            {
                                path: "docker-hosts",
                                component: DockerHosts,
                            },
                            {
                                path: "remote-browsers",
                                component: RemoteBrowsers,
                            },
                            {
                                path: "security",
                                component: Security,
                            },
                            {
                                path: "api-keys",
                                component: APIKeys,
                            },
                            {
                                path: "proxies",
                                component: Proxies,
                            },
                            {
                                path: "about",
                                component: About,
                            },
                        ],
                    },
                    {
                        path: "/manage-status-page",
                        component: ManageStatusPage,
                    },
                    {
                        path: "/add-status-page",
                        component: AddStatusPage,
                    },
                    {
                        path: "/maintenance",
                        component: ManageMaintenance,
                    },
                    {
                        path: "/add-maintenance",
                        component: EditMaintenance,
                    },
                    {
                        path: "/maintenance/edit/:id",
                        component: EditMaintenance,
                    },
                    {
                        path: "/maintenance/clone/:id",
                        component: EditMaintenance,
                    },
                ],
            },
        ],
    },
    {
        path: "/setup",
        component: Setup,
    },
    {
        path: "/setup-database",
        component: SetupDatabase,
    },
    {
        path: "/status-page",
        component: StatusPage,
    },
    {
        path: "/status",
        component: StatusPage,
    },
    {
        path: "/status/:slug",
        component: StatusPage,
    },
    {
        path: "/:pathMatch(.*)*",
        component: NotFound,
    },
];

export const router = createRouter({
    linkActiveClass: "active",
    history: createWebHistory(),
    routes,
});
