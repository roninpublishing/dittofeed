import React from "react";

import Layout from "./layout";
import menuItems from "./menuItems/main";
import publisherMenuItems from "./menuItems/publisher";

export default function MainLayout({
  publisherManagement = false,
  ...props
}: Omit<React.ComponentProps<typeof Layout>, "items"> & {
  publisherManagement?: boolean;
}) {
  return (
    <Layout
      items={publisherManagement ? publisherMenuItems : menuItems.items}
      {...props}
    />
  );
}
