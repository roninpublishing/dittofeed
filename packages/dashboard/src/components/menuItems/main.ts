import {
  BarChartOutlined,
  BoltOutlined,
  BookOutlined,
  CampaignOutlined,
  GroupsOutlined,
  HomeOutlined,
  InboxOutlined,
  LanOutlined,
  ManageAccountsOutlined,
  PeopleOutlined,
  PersonOutlined,
} from "@mui/icons-material";

import { MenuItemGroup } from "./types";

// ==============================|| MENU ITEMS ||============================== //

const menuItems: { items: MenuItemGroup[] } = {
  items: [
    {
      id: "home-navigation",
      title: "",
      type: "group",
      children: [
        {
          id: "home",
          title: "Home",
          type: "item",
          url: "/home",
          icon: HomeOutlined,
          description: "Open your workspace home dashboard.",
        },
        {
          id: "publications",
          title: "Newsletters",
          type: "item",
          url: "/publications",
          icon: BookOutlined,
          description: "Manage independent publications and publisher-wide sending infrastructure.",
        },
      ],
    },
    {
      id: "reporting",
      title: "Reporting",
      type: "group",
      children: [
        {
          id: "analysis",
          title: "Analysis",
          type: "item",
          url: "/analysis/overview",
          icon: BarChartOutlined,
          description: "Analyze metrics across your entire workspace.",
        },
        {
          id: "deliveries",
          title: "Deliveries",
          type: "item",
          url: "/deliveries",
          icon: InboxOutlined,
          description: "See which messages were delivered to which users.",
        },
      ],
    },
    {
      id: "messaging",
      title: "Messaging",
      type: "group",
      children: [
        {
          id: "journeys",
          title: "Journeys",
          type: "item",
          url: "/journeys",
          icon: LanOutlined,
          description: "View and, create, and edit user journeys.",
        },
        {
          id: "messages",
          title: "Message Templates",
          type: "item",
          url: "/templates",
          icon: BookOutlined,
          description: "View, create, and edit message templates.",
        },
        {
          id: "broadcasts",
          title: "Broadcasts",
          type: "item",
          url: "/broadcasts",
          icon: CampaignOutlined,
          description: "Broadcast one off messages to users.",
        },
      ],
    },
    {
      id: "audience",
      title: "Audience",
      type: "group",
      children: [
        {
          id: "people",
          title: "Users",
          type: "item",
          url: "/users",
          icon: PersonOutlined,
          description: "View users, and their histories.",
        },
        {
          id: "segments",
          title: "Segments",
          type: "item",
          url: "/segments",
          icon: GroupsOutlined,
          description: "View, create, and edit segments.",
        },
        {
          id: "user-properties",
          title: "User Properties",
          type: "item",
          url: "/user-properties",
          icon: ManageAccountsOutlined,
          description:
            "Manage the properties which are recorded and computed for users.",
        },
        {
          id: "subscription-groups",
          title: "Subscription Groups",
          type: "item",
          url: "/subscription-groups",
          icon: PeopleOutlined,
          description: "Manage subscription groups of users.",
        },
        {
          id: "events",
          title: "Events",
          type: "item",
          url: "/events",
          icon: BoltOutlined,
          description: "View user events.",
        },
      ],
    },
  ],
};

export default menuItems;
