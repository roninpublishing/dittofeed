import {
  BarChartOutlined,
  BookOutlined,
  DnsOutlined,
  HubOutlined,
  PeopleOutlined,
  SchemaOutlined,
  SettingsEthernetOutlined,
  SettingsOutlined,
} from "@mui/icons-material";

import { MenuItemGroup } from "./types";

const publisherMenuItems: MenuItemGroup[] = [
  {
    id: "publisher-navigation",
    title: "",
    type: "group",
    children: [
      {
        id: "workspace-overview",
        title: "Overview",
        type: "item",
        url: "/workspace",
        icon: SchemaOutlined,
        description: "Workspace map",
      },
      {
        id: "publications",
        title: "Newsletters",
        type: "item",
        url: "/workspace/newsletters",
        icon: BookOutlined,
        description: "Open a newsletter to manage its audience and campaigns.",
      },
      {
        id: "workspace-esp-accounts",
        title: "ESP accounts",
        type: "item",
        url: "/workspace/esp-accounts",
        icon: HubOutlined,
        description: "Manage sending accounts",
      },
      {
        id: "workspace-ips",
        title: "Dedicated IPs",
        type: "item",
        url: "/workspace/ips",
        icon: SettingsEthernetOutlined,
        description: "Manage dedicated IPs",
      },
      {
        id: "workspace-ip-pools",
        title: "Shared IPs",
        type: "item",
        url: "/workspace/ip-pools",
        icon: DnsOutlined,
        description: "Manage shared IP pools",
      },
      {
        id: "publisher-subscribers",
        title: "Subscribers",
        type: "item",
        url: "/workspace/subscribers",
        icon: PeopleOutlined,
        description: "Find subscriber records across your newsletters.",
      },
      {
        id: "publisher-reports",
        title: "Reports",
        type: "item",
        url: "/workspace/reports",
        icon: BarChartOutlined,
        description: "View reporting across your newsletters.",
      },
      {
        id: "publisher-settings",
        title: "Settings",
        type: "item",
        url: "/workspace/settings",
        icon: SettingsOutlined,
        description: "Manage workspace settings.",
      },
    ],
  },
];

export default publisherMenuItems;
