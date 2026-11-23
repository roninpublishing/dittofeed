import {
  BarChartOutlined,
  BookOutlined,
  PeopleOutlined,
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
        id: "publications",
        title: "Newsletters",
        type: "item",
        url: "/publications",
        icon: BookOutlined,
        description: "Open a newsletter to manage its audience and campaigns.",
      },
      {
        id: "publisher-subscribers",
        title: "Subscribers",
        type: "item",
        url: "/publications?view=subscribers",
        icon: PeopleOutlined,
        description: "Find subscriber records across your newsletters.",
      },
      {
        id: "publisher-reports",
        title: "Reports",
        type: "item",
        url: "/publications?view=reports",
        icon: BarChartOutlined,
        description: "View reporting across your newsletters.",
      },
      {
        id: "publisher-settings",
        title: "Publisher settings",
        type: "item",
        url: "/publications?view=settings",
        icon: SettingsOutlined,
        description: "Manage shared sending, tracking and publisher controls.",
      },
    ],
  },
];

export default publisherMenuItems;
