// material-ui
import { Box, List, Typography } from "@mui/material";
import { useRouter } from "next/router";

import { activeNavigationUrl } from "../../../../../lib/navigation";
import { MenuItemGroup } from "../../../../menuItems/types";
// project import
import NavItem from "./navItem";

// ==============================|| NAVIGATION - LIST GROUP ||============================== //

function NavGroup({ item }: { item: MenuItemGroup }) {
  const { asPath } = useRouter();
  const selectedUrl = activeNavigationUrl(
    asPath,
    item.children.map((child) => child.url),
  );
  const navCollapse = item.children.map((menuItem) => (
    <NavItem
      key={menuItem.id}
      item={menuItem}
      level={1}
      isSelected={menuItem.url === selectedUrl}
    />
  ));

  return (
    <List
      subheader={
        item.title && (
          <Box sx={{ px: 1, pt: 1, pb: 0.5 }}>
            <Typography variant="subtitle2" color="textSecondary">
              {item.title}
            </Typography>
          </Box>
        )
      }
      sx={{ mb: 1, py: 0, zIndex: 0 }}
    >
      {navCollapse}
    </List>
  );
}

export default NavGroup;
